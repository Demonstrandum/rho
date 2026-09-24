/**
 * The far side's user interface, drawn here.
 *
 * Two halves of one problem, so they live in one file.
 *
 * In the client that draws a remote session, this is the only thing holding a
 * `ctx.ui`, so it takes each request the relay carries (a notification, a
 * status line, a widget, a dialog) and draws it, then sends the answer back.
 * Without it a command run on the far side produced nothing at all: rpc mode
 * emits every `ctx.ui` call as a frame and the client threw them away.
 *
 * In the session itself, which runs as `pi --mode rpc` and has no terminal,
 * `ctx.ui.custom` is present and answers undefined. An extension that offers a
 * component and falls back to a plain dialog checks whether `custom` exists,
 * finds it, offers the component, and is answered with nothing: that is what
 * `/rewind` on a remote session did, and why it looked like the command did
 * nothing. Taking `custom` off the rpc context makes those extensions take
 * their fallback, which is `ui.select` -- a dialog the relay can carry.
 *
 * [remote] relay-ui in rho.toml turns both halves off.
 *
 * See docs/extensions.md.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { config } from './lib/core/config';
import { publishedRelay, type RelayHandle, type UiRequest } from './lib/remote/ui-relay';

/** what pi's rpc mode cannot do, and what an extension checks for before offering it. */
const UNDRAWABLE = ['custom', 'onTerminalInput', 'setEditorComponent'] as const;

/**
 * Take the undrawable methods off the rpc context.
 *
 * pi builds one ui context per session in rpc mode and every extension reads
 * that same object, so removing a method here removes it for all of them. The
 * methods being removed do nothing in that mode: `custom` resolves undefined
 * without emitting a frame, and the other two return immediately. An extension
 * that checks for them is asking whether there is a terminal, and the honest
 * answer on a daemon is no.
 */
function tellTheTruthAboutUi(ctx: ExtensionContext): void {
    const ui = ctx.ui as unknown as Record<string, unknown>;
    for (const method of UNDRAWABLE) {
        if (typeof ui[method] !== 'function') continue;
        try {
            ui[method] = undefined;
        } catch {
            // a frozen context is pi's to decide; the relay still carries
            // everything else.
        }
    }
}

/** One request, drawn with this interface's own dialogs. */
async function draw(ctx: ExtensionContext, relay: RelayHandle, request: UiRequest): Promise<void> {
    switch (request.method) {
        case 'notify':
            ctx.ui.notify(request.message, request.level);
            return;
        case 'setStatus':
            ctx.ui.setStatus(request.key, request.text);
            return;
        case 'setWidget':
            ctx.ui.setWidget(request.key, request.lines === undefined ? undefined : [...request.lines], {
                placement: request.placement,
            });
            return;
        case 'setTitle':
            ctx.ui.setTitle(request.title);
            return;
        case 'setEditorText':
            ctx.ui.setEditorText(request.text);
            return;
        case 'select': {
            const chosen = await ctx.ui.select(request.title, [...request.options], { timeout: request.timeoutMs });
            relay.answer(request.id, chosen === undefined ? { cancelled: true } : { value: chosen });
            return;
        }
        case 'confirm': {
            const agreed = await ctx.ui.confirm(request.title, request.message, { timeout: request.timeoutMs });
            relay.answer(request.id, { confirmed: agreed });
            return;
        }
        case 'input': {
            const typed = await ctx.ui.input(request.title, request.placeholder, { timeout: request.timeoutMs });
            relay.answer(request.id, typed === undefined ? { cancelled: true } : { value: typed });
            return;
        }
        case 'editor': {
            const written = await ctx.ui.editor(request.title, request.prefill);
            relay.answer(request.id, written === undefined ? { cancelled: true } : { value: written });
            return;
        }
    }
}

/**
 * One dialog at a time, in the order they were asked.
 *
 * Two commands on the far side can each open one, and pi's interface gives the
 * keyboard to whichever component was shown last: the first dialog would then
 * be waiting on a keystroke it can never receive, and the command behind it
 * never returns. The queue also keeps a notification from being swallowed
 * while a dialog holds the screen.
 */
function inTurn(run: (request: UiRequest) => Promise<void>): (request: UiRequest) => void {
    let tail: Promise<void> = Promise.resolve();
    return (request) => {
        tail = tail.then(() => run(request)).catch(() => undefined);
    };
}

export default function (pi: ExtensionAPI) {
    if (!config.remote.relayUi) return;

    let drawing: (() => void) | null = null;
    /** the most recent context, since a handler's own is only valid while it runs. */
    let seat: ExtensionContext | null = null;

    const start = (ctx: ExtensionContext): void => {
        seat = ctx;
        if (ctx.mode === 'rpc') {
            tellTheTruthAboutUi(ctx);
            return;
        }
        if (drawing !== null) return;
        const relay = publishedRelay();
        if (relay === null) return;
        drawing = relay.onRequest(
            inTurn(async (request) => {
                const here = seat;
                if (here === null) return;
                try {
                    await draw(here, relay, request);
                } catch (error) {
                    // A dialog this interface could not show still owes the far
                    // side an answer, or the command behind it waits for ever.
                    relay.cancel(request.id);
                    here.ui.notify(`could not show a dialog from the session: ${(error as Error).message}`, 'error');
                }
            }),
        );
    };

    pi.on('session_start', async (_event, ctx) => start(ctx));
    // The context a handler is given is the live one, and the relay draws
    // between turns as well as during them: the newest is kept rather than the
    // one the session opened with.
    pi.on('agent_start', async (_event, ctx) => start(ctx));
    pi.on('agent_end', async (_event, ctx) => start(ctx));
    pi.on('session_shutdown', async () => {
        drawing?.();
        drawing = null;
        seat = null;
    });
}
