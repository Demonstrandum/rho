import { platform, release } from 'node:os';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { config } from './lib/config';
import { currentEnvironment } from './environment';

// states the facts about the machine and the session that the agent otherwise
// spends a tool call to learn: where it is, what it is running on, what day it
// is, and which model it is.
//
// pi gives the working directory and then says "you can inspect PI_* environment
// variables for current model and session details", which is a shell call for
// something a line of text can carry. the date is the one that matters most: with
// no date in the prompt a model reasons from its training cutoff, and dates every
// "recent" release wrongly.
//
// the block is built once and reused for the rest of the session. it sits in the
// cached prefix of every request, so a byte that changes between turns
// invalidates the cache from that point on: a session running past midnight would
// pay a full re-read for a date nobody asked for. the model and the working
// directory can change mid-session (ctrl+l, /cwd) and those do rebuild it, since
// one cache miss is cheaper than a prompt that lies about which model is reading
// it.
/**
 * whether the working directory is a git work tree. `unknown` is the answer when
 * the question could not be put to git at all, and it is a third state rather
 * than a fold into `no`: a failed probe reported as `no` states a falsehood about
 * the directory, and the agent has no way to see that it was a failure.
 */
export type RepoState = 'yes' | 'no' | 'unknown';

const REPO_LINE: Record<RepoState, string> = {
    yes: 'yes',
    no: 'no',
    unknown: 'could not be determined; run git yourself before acting on the tree',
};

interface Facts {
    readonly cwd: string;
    readonly repo: RepoState;
    readonly platform: string;
    readonly date: string;
    readonly model: string;
    /** which shell bash tool commands are handed to. */
    readonly shell: string;
    /** the machine the tools act on: absent when that is this one. */
    readonly host?: string;
}

export const probeRepo = async (cwd: string): Promise<RepoState> => {
    try {
        const proc = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
            cwd,
            stdout: 'pipe',
            stderr: 'ignore',
            // passed rather than inherited, so the lookup of git follows the
            // PATH this process holds now.
            env: { ...process.env },
        });
        const out = (await new Response(proc.stdout).text()).trim();
        // git answers `false` inside a bare repository, and exits non-zero with
        // no output outside a work tree. both are answers.
        if (out === 'true') return 'yes';
        if (out === 'false') return 'no';
        return (await proc.exited) === 0 ? 'unknown' : 'no';
    } catch {
        // git missing from PATH, or a runtime without Bun.spawn: the probe never
        // ran, so the directory is not what this describes.
        return 'unknown';
    }
};

const modelLine = (ctx: ExtensionContext): string => {
    const model = ctx.model;
    if (model === undefined) return 'none selected';
    const thinking = ctx.thinkingLevel;
    const id = `${model.provider}/${model.id}`;
    return thinking === undefined || thinking === 'off' ? id : `${id}, thinking ${thinking}`;
};

const gather = async (ctx: ExtensionContext): Promise<Facts> => {
    // An attached environment is where the tools act, so it is what the block
    // describes: the laptop's directory and shell are not what a command will
    // see. Local details stay for date and model, which belong to the session
    // rather than to a machine.
    const remote = currentEnvironment();
    if (remote !== undefined && remote.alive) {
        return {
            cwd: remote.cwd,
            repo: 'unknown',
            platform: `remote via ${remote.host}`,
            date: new Date().toISOString().slice(0, 10),
            model: modelLine(ctx),
            shell: remote.shell,
            host: remote.host,
        };
    }
    return {
        cwd: ctx.cwd,
        repo: await probeRepo(ctx.cwd),
        platform: `${platform()} ${release()}`,
        // ISO 8601, per the orthography rules; frozen for the session.
        date: new Date().toISOString().slice(0, 10),
        model: modelLine(ctx),
        shell: process.env.SHELL ?? 'unknown',
    };
};

export const render = (facts: Facts, fields: RenderFields): string => {
    // The host first, and only when the tools are acting elsewhere: a session
    // that says nothing about the machine is describing this one, and a model
    // reading a local cwd while its commands run in another country will
    // reason about files that are not there.
    const lines = facts.host === undefined ? [] : [`host: ${facts.host}`];
    lines.push(`cwd: ${facts.cwd}`);
    if (fields.git) lines.push(`git repo: ${REPO_LINE[facts.repo]}`);
    if (fields.shell) lines.push(`shell: ${facts.shell}`);
    if (fields.platform) lines.push(`platform: ${facts.platform}`);
    if (fields.date) lines.push(`date: ${facts.date}`);
    if (fields.model) lines.push(`model: ${facts.model}`);
    return `<env>\n${lines.join('\n')}\n</env>`;
};

export interface RenderFields {
    readonly git: boolean;
    readonly platform: boolean;
    readonly date: boolean;
    readonly model: boolean;
    readonly shell: boolean;
}

export default function (pi: ExtensionAPI) {
    if (!config.env.enabled) return;

    const fields: RenderFields = {
        git: config.env.git,
        platform: config.env.platform,
        date: config.env.date,
        model: config.env.model,
        shell: config.env.shell,
    };

    let block: string | null = null;
    let builtFor: string | null = null;

    pi.on('before_agent_start', async (event, ctx) => {
        // the identity of the facts that may change within a session; a change
        // rebuilds the block and costs one cache miss.
        // The environment is part of the identity: switching machine has to
        // rebuild the block, or the model keeps reading the old one.
        const remote = currentEnvironment();
        const key = `${ctx.cwd}\u0000${modelLine(ctx)}\u0000${remote?.host ?? 'local'}\u0000${remote?.cwd ?? ''}`;
        if (block === null || key !== builtFor) {
            block = render(await gather(ctx), fields);
            builtFor = key;
        }
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
}
