import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { config } from './lib/core/config';
import { prepare } from './lib/session/scratchpad';

// gives the session one directory for intermediate files, names it in the
// prompt, and exports it as RHO_SCRATCH so a bash call can reach it without the
// path being retyped.
//
// the alternative is what happens now: temporary work goes to /tmp, where it is
// mixed with every other process's files, survives the session, and is refused
// by any tool confined to the workspace. context-mode rejects a read outside the
// project root, so a /tmp file written by bash cannot then be summarised by
// ctx_execute_file.
//
// that refusal is what decides the default location. `.rho/scratch/<session>/`
// inside the working tree is readable by every tool and needs one .gitignore
// line; `[scratch] location = data-dir` moves it under the rho data directory
// for a working tree that must stay untouched, and `off` registers nothing.
//
// directories older than [scratch] keep-days are removed when a session opens,
// which is the rule lib/state-store.ts uses for its session files.
export default function (pi: ExtensionAPI) {
    if (config.scratch.location === 'off') return;

    pi.on('session_start', async (_event, ctx) => {
        let dir: string | null = null;
        try {
            dir = prepare(
                config.scratch.location,
                { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
                config.scratch.keepDays,
            );
        } catch {
            // a read-only working tree is a reason to have no scratch
            // directory, not a reason to fail the session.
            return;
        }
        if (dir === null) return;
        process.env['RHO_SCRATCH'] = dir;
    });

    pi.on('before_agent_start', async (event) => {
        const dir = process.env['RHO_SCRATCH'];
        if (dir === undefined) return;
        return {
            systemPrompt: `${event.systemPrompt}\n\n<scratch>\n`
                + `${dir}\n`
                + 'write intermediate files, working scripts, and throwaway output here rather than in /tmp.\n'
                + 'it is also $RHO_SCRATCH in a shell.\n'
                + 'files here are yours to delete; nothing in it belongs to the user.\n'
                + '</scratch>',
        };
    });
}
