// /project: a repository and a branch, checked out wherever the agent is.
//
// `/remote project` made this layout on a machine and started a session in it,
// which meant the only way to get a project was to want a session as well. The
// layout is the useful part: one clone under ~/projects/<project>/checkout and
// a worktree per branch beside it, the same shape on every machine, so a path
// learnt on one is a path on the next.
//
// This asks for it wherever the tools currently act: the laptop when nothing is
// attached, and the attached machine when something is. `/remote project` is
// the same thing plus a session, and both build it from one definition.
//
// The first word is a repository or the name of a project already checked out
// there, since that is what people have once the clone exists. A branch that
// does not exist yet starts where `from <base>` says, and otherwise at the
// repository's own default branch.

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { currentEnvironment } from './environment';
import { parseProjectRequest, sourceLabel } from './lib/remote/naming';
import { projectPlan, scriptComplaint } from './lib/remote/project';
import { agentTrouble, describeAgentTrouble } from './lib/remote/ssh-agent';
import { completeLastWord, lastWord } from './lib/tui/complete-words';
import { moveHere } from './cwd';
import { announceWhere, gitThrough, registerLocationRenderer } from './lib/git/where-note';
import type { WordChoice } from './lib/tui/complete-words';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';

/**
 * Projects already checked out on this machine.
 *
 * Only this machine: an attached one would have to be asked over the link,
 * and a completion list is drawn while the person types. With something
 * attached the list would name projects that are not where the checkout will
 * land, so it is left empty instead.
 */
function projectsHere(): WordChoice[] {
    const elsewhere = currentEnvironment();
    if (elsewhere !== undefined && elsewhere.alive) return [];
    try {
        return readdirSync(join(process.env.HOME ?? '', 'projects'), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({ value: entry.name, description: 'already here' }));
    } catch {
        return [];
    }
}

/** Run a script here, and give back its last line and what it said last. */
const locally = (script: string): Promise<{ last: string | null; said: string }> =>
    new Promise((settle) => {
        const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
        child.on('error', (trouble) => settle({ last: null, said: trouble.message }));
        child.on('close', (code) => {
            const lines = out.trim().split('\n').filter((line) => line.trim() !== '');
            if (code !== 0) {
                settle({ last: null, said: scriptComplaint(err === '' ? out : err, code) });
                return;
            }
            settle({ last: lines[lines.length - 1] ?? null, said: '' });
        });
    });

/** The checkout itself, so the command and the tool are one behaviour. */
async function checkout(
    pi: ExtensionAPI,
    line: string,
    say: (note: string, kind?: 'info' | 'error') => void,
): Promise<{ ok: boolean; text: string }> {
    const asked = parseProjectRequest(line.trim().split(/\s+/).filter(Boolean));
    if (asked === null) {
        return { ok: false, text: 'give a repository or a project already here: <repo|project> [branch] [from <base>] [as <name>]' };
    }

    const elsewhere = currentEnvironment();
    const where = elsewhere !== undefined && elsewhere.alive ? elsewhere : null;
    const plan = projectPlan({ source: asked.source, branch: asked.branch, base: asked.base, name: asked.name });
    const from = asked.base === null ? '' : ` from ${asked.base}`;
    say(`checking out ${asked.branch}${from} of ${sourceLabel(asked.source)} on ${where === null ? 'this machine' : where.name}`);

    // The far side runs it through the environment's own shell, so the agent
    // forwarded to that machine is the one github sees.
    const shell = (globalThis as { __rho_shell_out?: (script: string) => Promise<{ last: string | null; said: string }> })
        .__rho_shell_out;
    const done =
        where === null
            ? await locally(plan.script)
            : shell === undefined
              ? { last: null, said: 'the environment cannot run a script' }
              : await shell(plan.script);

    if (done.last === null) {
        // git's refusal names the key it was offered, which is none, so it
        // reads as a GitHub problem. The agent is the usual cause and it is
        // cheap to check here, where the repository and the machine are both
        // known.
        const denied = /permission denied|could not read from remote repository|authentication failed/i.test(done.said);
        const trouble = denied ? agentTrouble() : null;
        const because =
            trouble !== null
                ? `\n${describeAgentTrouble(trouble, `${sourceLabel(asked.source)}${where === null ? '' : ` on ${where.name}`}`)}`
                : denied && where !== null
                  ? '\nthis machine has an agent with keys, so the one the far side sees is the forwarded one: reconnect the environment, which forwards it afresh.'
                  : '';
        return { ok: false, text: `could not check out ${sourceLabel(asked.source)}: ${done.said}${because}` };
    }
    if (where === null) {
        // The tool says the working directory moves into the worktree, and on
        // this machine nothing was moving it: the checkout was made and the
        // session went on standing where it was.
        let moved = done.last;
        try {
            moved = moveHere(done.last);
        } catch (trouble) {
            return { ok: true, text: `${done.last} on this machine (${(trouble as Error).message})` };
        }
        await announceWhere(pi, 'project', { host: null, cwd: moved });
        return { ok: true, text: `${moved} is the working directory now, on this machine` };
    }
    await where.chdir(done.last);
    await announceWhere(pi, 'project', {
        host: where.host,
        cwd: done.last,
        git: gitThrough((command, timeoutMs) => where.capture(command, timeoutMs)),
    });
    return { ok: true, text: `${where.name}:${done.last} is the working directory now` };
}

export default function (pi: ExtensionAPI) {
    registerLocationRenderer(pi);
    pi.registerTool({
        name: 'project',
        label: 'Project',
        description:
            'Check out a repository and branch where the tools are acting: one clone under ~/projects/<project>/checkout and a worktree per branch, and the working directory moves into the worktree. Works on this machine, or on the attached one. A project already checked out is named rather than cloned again.',
        promptSnippet: 'Check out a repository and branch',
        promptGuidelines: [
            'Use project rather than a hand-written git clone, so every machine has the same layout and a second branch reuses the clone.',
        ],
        parameters: Type.Object({
            repo: Type.String({
                description:
                    'The repository, as git would take it, or the name of a project already checked out here, which is found rather than cloned.',
            }),
            branch: Type.Optional(Type.String({ description: 'Defaults to main.' })),
            base: Type.Optional(
                Type.String({
                    description:
                        'Where the branch starts, when it does not exist yet. Defaults to the repository default branch.',
                }),
            ),
            name: Type.Optional(Type.String({ description: 'What to call the project. Defaults to the repository name.' })),
        }),
        async execute(_id: string, params: { repo: string; branch?: string; base?: string; name?: string }) {
            const line = [
                params.repo,
                params.branch ?? 'main',
                ...(params.base === undefined ? [] : ['from', params.base]),
                ...(params.name === undefined ? [] : ['as', params.name]),
            ].join(' ');
            const done = await checkout(pi, line, () => {});
            return { content: [{ type: 'text' as const, text: done.text }], details: undefined };
        },
    });

    pi.registerCommand('project', {
        description:
            'check out a repository and branch where the tools are acting: /project <repo|project> [branch] [from <base>] [as <name>]',
        getArgumentCompletions: (text) =>
            completeLastWord(
                text,
                lastWord(text).before.trim() === ''
                    ? projectsHere()
                    : [{ value: 'from' }, { value: 'as' }, { value: 'main' }, { value: 'master' }],
            ),
        handler: async (args: string, ctx: ExtensionContext) => {
            const done = await checkout(pi, args, (note, kind) => ctx.ui.notify(note, kind ?? 'info'));
            ctx.ui.notify(done.text, done.ok ? 'info' : 'error');
        },
    });
}
