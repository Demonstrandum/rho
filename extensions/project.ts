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

export default function (pi: ExtensionAPI) {
    pi.registerCommand('project', {
        description:
            'check out a repository and branch where the tools are acting: /project <repo> [branch] [as <name>]',
        getArgumentCompletions: (text) =>
            completeLastWord(text, [{ value: 'as' }, { value: 'main' }, { value: 'master' }]),
        handler: async (args: string, ctx: ExtensionContext) => {
            const asked = parseProjectRequest(args.trim().split(/\s+/).filter(Boolean));
            if (asked === null) {
                ctx.ui.notify('Usage: /project <repo> [branch] [as <name>]', 'error');
                return;
            }

            const elsewhere = currentEnvironment();
            const where = elsewhere !== undefined && elsewhere.alive ? elsewhere : null;
            const plan = projectPlan(asked.repo, asked.branch, asked.name ?? undefined);
            ctx.ui.notify(
                `checking out ${asked.branch} of ${asked.repo} on ${where === null ? 'this machine' : where.name}`,
                'info',
            );

            // The far side runs it through the environment's own shell, so the
            // agent forwarded to that machine is the one github sees.
            const done =
                where === null
                    ? await locally(plan.script)
                    : await (async () => {
                          const shell = (globalThis as { __rho_shell_out?: (script: string) => Promise<{ last: string | null; said: string }> })
                              .__rho_shell_out;
                          if (shell === undefined) return { last: null, said: 'the environment cannot run a script' };
                          return shell(plan.script);
                      })();

            if (done.last === null) {
                ctx.ui.notify(`Could not check out ${asked.repo}: ${done.said}`, 'error');
                return;
            }

            if (where === null) {
                ctx.ui.notify(`${done.last} — /cwd ${done.last} moves there.`, 'info');
                return;
            }
            await where.chdir(done.last);
            ctx.ui.notify(`${where.name}:${done.last} is the working directory now.`, 'info');
        },
    });
}
