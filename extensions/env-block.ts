import { platform, release } from 'node:os';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { config } from './lib/config';

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
interface Facts {
    readonly cwd: string;
    readonly repo: boolean;
    readonly platform: string;
    readonly date: string;
    readonly model: string;
}

const isGitRepo = async (cwd: string): Promise<boolean> => {
    try {
        const proc = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
            cwd,
            stdout: 'pipe',
            stderr: 'ignore',
        });
        const out = (await new Response(proc.stdout).text()).trim();
        return out === 'true';
    } catch {
        return false;
    }
};

const modelLine = (ctx: ExtensionContext): string => {
    const model = ctx.model;
    if (model === undefined) return 'none selected';
    const thinking = ctx.thinkingLevel;
    const id = `${model.provider}/${model.id}`;
    return thinking === undefined || thinking === 'off' ? id : `${id}, thinking ${thinking}`;
};

const gather = async (ctx: ExtensionContext): Promise<Facts> => ({
    cwd: ctx.cwd,
    repo: await isGitRepo(ctx.cwd),
    platform: `${platform()} ${release()}`,
    // ISO 8601, per the orthography rules; frozen for the session.
    date: new Date().toISOString().slice(0, 10),
    model: modelLine(ctx),
});

export const render = (facts: Facts, fields: RenderFields): string => {
    const lines = [`cwd: ${facts.cwd}`];
    if (fields.git) lines.push(`git repo: ${facts.repo ? 'yes' : 'no'}`);
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
}

export default function (pi: ExtensionAPI) {
    if (!config.env.enabled) return;

    const fields: RenderFields = {
        git: config.env.git,
        platform: config.env.platform,
        date: config.env.date,
        model: config.env.model,
    };

    let block: string | null = null;
    let builtFor: string | null = null;

    pi.on('before_agent_start', async (event, ctx) => {
        // the identity of the facts that may change within a session; a change
        // rebuilds the block and costs one cache miss.
        const key = `${ctx.cwd}\u0000${modelLine(ctx)}`;
        if (block === null || key !== builtFor) {
            block = render(await gather(ctx), fields);
            builtFor = key;
        }
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
}
