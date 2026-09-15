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

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { currentEnvironment } from './environment';
import { parseProjectRequest } from './lib/remote/naming';
import { projectPlan } from './lib/remote/project';
import { completeLastWord } from './lib/complete-words';
import { Type } from 'typebox';

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
                const complaint = err.trim().split('\n').filter((line) => line.trim() !== '');
                settle({ last: null, said: complaint[complaint.length - 1] ?? `it exited ${code}` });
                return;
            }
            settle({ last: lines[lines.length - 1] ?? null, said: '' });
        });
    });

/** The checkout itself, so the command and the tool are one behaviour. */
async function checkout(
    line: string,
    say: (note: string, kind?: 'info' | 'error') => void,
): Promise<{ ok: boolean; text: string }> {
    const asked = parseProjectRequest(line.trim().split(/\s+/).filter(Boolean));
    if (asked === null) return { ok: false, text: 'give a repository: <repo> [branch] [as <name>]' };

    const elsewhere = currentEnvironment();
    const where = elsewhere !== undefined && elsewhere.alive ? elsewhere : null;
    const plan = projectPlan(asked.repo, asked.branch, asked.name ?? undefined);
    say(`checking out ${asked.branch} of ${asked.repo} on ${where === null ? 'this machine' : where.name}`);

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

    if (done.last === null) return { ok: false, text: `could not check out ${asked.repo}: ${done.said}` };
    if (where === null) return { ok: true, text: `${done.last} on this machine` };
    await where.chdir(done.last);
    return { ok: true, text: `${where.name}:${done.last} is the working directory now` };
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: 'project',
        label: 'Project',
        description:
            'Check out a repository and branch where the tools are acting: one clone under ~/projects/<project>/checkout and a worktree per branch, and the working directory moves into the worktree. Works on this machine, or on the attached one.',
        promptSnippet: 'Check out a repository and branch',
        promptGuidelines: [
            'Use project rather than a hand-written git clone, so every machine has the same layout and a second branch reuses the clone.',
        ],
        parameters: Type.Object({
            repo: Type.String({ description: 'The repository, as git would take it.' }),
            branch: Type.Optional(Type.String({ description: 'Defaults to main.' })),
            name: Type.Optional(Type.String({ description: 'What to call the project. Defaults to the repository name.' })),
        }),
        async execute(_id: string, params: { repo: string; branch?: string; name?: string }) {
            const line = [params.repo, params.branch ?? 'main', ...(params.name === undefined ? [] : ['as', params.name])].join(' ');
            const done = await checkout(line, () => {});
            return { content: [{ type: 'text' as const, text: done.text }], details: undefined };
        },
    });

    pi.registerCommand('project', {
        description:
            'check out a repository and branch where the tools are acting: /project <repo> [branch] [as <name>]',
        getArgumentCompletions: (text) =>
            completeLastWord(text, [{ value: 'as' }, { value: 'main' }, { value: 'master' }]),
        handler: async (args: string, ctx: ExtensionContext) => {
            const done = await checkout(args, (note, kind) => ctx.ui.notify(note, kind ?? 'info'));
            ctx.ui.notify(done.text, done.ok ? 'info' : 'error');
        },
    });
}
