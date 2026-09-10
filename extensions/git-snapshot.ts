import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { config } from './lib/config';
import { render, renderFailure, snapshot, type Reading } from './lib/git-snapshot';

// appends a <git> block: the branch and its divergence from upstream, the dirty
// files, and the last few commit subjects.
//
// without it every session opens with the agent running git status and git log by
// hand to learn what it is standing in, and an agent that skips that step edits
// from a wrong picture of the tree.
//
// the read is started at session_start and awaited at the first turn. git status
// on a large work tree is not instant and session_start is awaited during
// startup, so blocking there would delay the first paint; by the time a prompt
// has been typed the read has long finished. a read that has not finished is
// dropped rather than waited on.
//
// the block says it does not update. that line is the point: a resumed session
// carries a snapshot from whenever it was first started, which is worse than no
// snapshot if it is read as current. on a resume the read runs again, so the text
// is at worst one session old, and the agent is told to look again before acting.
export default function (pi: ExtensionAPI) {
    if (!config.git.snapshot) return;

    let pending: Promise<Reading> | null = null;
    let block: string | null = null;

    pi.on('session_start', async (_event, ctx) => {
        block = null;
        pending = snapshot({
            cwd: ctx.cwd,
            commits: config.git.commits,
            maxFiles: config.git.maxFiles,
            timeoutMs: config.git.timeoutMs,
        });
    });

    pi.on('before_agent_start', async (event) => {
        if (block === null && pending !== null) {
            const reading = await pending;
            pending = null;
            // a read that failed says so; only a directory outside a work tree
            // contributes nothing.
            block = reading.kind === 'snapshot' ? render(reading.state) : renderFailure(reading.failure);
        }
        if (block === null) return;
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
}
