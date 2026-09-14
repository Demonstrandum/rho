// end the session by typing it. pi exits on ctrl+D and on /quit; this adds
// /exit, and the same words with no slash at all, since a shell trains you to
// type quit and press enter.
//
// the slash forms are registered as commands, so each one appears in the
// completion menu with a description. a word pi already defines is skipped:
// interactive mode matches its own commands before it dispatches to an
// extension, so an extension command of that name could never run, and
// registering it would only put a second entry in the menu.
//
// the bare form cannot be a command, so it goes through the `input` event,
// which sees a message before the agent does. it is restricted to typed input:
// an rpc client or another extension sending the text "quit" means the word.
//
// both paths call ctx.shutdown(), which is what /quit and ctrl+D reach. pi
// defers it until the agent is idle, so a word typed mid-turn ends the session
// after the turn settles rather than killing the run.

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { config } from './lib/config';
import { builtinCommandNames } from './lib/pi-docs';

function leave(ctx: ExtensionContext): void {
    if (!ctx.isIdle()) {
        ctx.ui.notify('exiting once the turn settles', 'info');
    }
    ctx.shutdown();
}

export default function (pi: ExtensionAPI) {
    const words = new Set(
        config.quit.words.map((word) => word.trim().toLowerCase()).filter((word) => word !== ''),
    );
    if (words.size === 0) return;

    const builtins = builtinCommandNames();
    for (const word of words) {
        if (builtins.has(word)) continue;
        pi.registerCommand(word, {
            description: 'quit pi',
            handler: async (_args, ctx) => {
                leave(ctx);
            },
        });
    }

    if (!config.quit.bareWord) return;

    pi.on('input', async (event, ctx) => {
        if (event.source !== 'interactive') return { action: 'continue' };
        if (event.images && event.images.length > 0) return { action: 'continue' };
        if (!words.has(event.text.trim().toLowerCase())) return { action: 'continue' };
        leave(ctx);
        return { action: 'handled' };
    });
}
