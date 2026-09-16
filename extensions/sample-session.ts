// `pi --sample-session`, and `/sample-session`: open a made-up session with
// every entry kind in it and two branch points.
//
// the transcript, the tree view, the pickers and the exporters are all hard to
// work on without a session to point them at, and the sessions that exist are
// somebody's work: their paths, their keys, their mistakes. this writes one
// from nothing, so it can go in a screenshot, be replayed on another machine,
// and be edited without losing anything.
//
// the file is written into the project's own session directory rather than a
// temporary one, so /resume, /tree, /fork and /export treat it as the real
// session it is. each run writes a new file; the old ones are ordinary
// sessions and are deleted the ordinary way.
//
// the flag cannot switch the session itself: session_start's context has no
// switchSession, that being a command's action. so the flag queues the command
// it is a shorthand for, and one path does the work.

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { sampleEntries } from './lib/sample-session';
import { writeSessionCopy } from './lib/session-file';

const COMMAND = 'sample-session';

async function openSample(ctx: ExtensionCommandContext): Promise<void> {
    const path = writeSessionCopy({
        sessionDir: ctx.sessionManager.getSessionDir(),
        cwd: ctx.cwd,
        entries: sampleEntries(),
    });
    await ctx.switchSession(path);
}

export default function (pi: ExtensionAPI) {
    pi.registerFlag(COMMAND, {
        description: 'open a made-up session with tool calls, thinking, and branches in it',
        type: 'boolean',
        default: false,
    });

    pi.registerCommand(COMMAND, {
        description: 'Open a made-up session with tool calls, thinking, and branches in it',
        handler: async (_args, ctx) => {
            await openSample(ctx);
        },
    });

    pi.on('session_start', async () => {
        if (pi.getFlag(COMMAND) !== true) return;
        // expandPromptTemplates is what makes this dispatch the command; without
        // it the text is sent to the model as a message that happens to start
        // with a slash.
        pi.sendUserMessage(`/${COMMAND}`, { deliverAs: 'followUp', expandPromptTemplates: true });
    });
}
