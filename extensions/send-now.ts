// cut into a running turn instead of waiting for the next boundary.
//
// pi has two ways in while the agent works, and both wait: enter queues a
// steering message, delivered after the current assistant turn finishes its
// tool calls, and alt+enter queues a follow-up, delivered after all work ends.
// escape stops the run and keeps the editor text, so the impatient path is
// already escape then enter. these keys are that pair in one press.
//
//   ctrl+enter        -> stop the run and send the queued messages together
//                        with whatever is typed, as one turn
//   ctrl+shift+enter  -> stop the run and send the newest queued message
//                        alone, putting the rest back in the editor
//   either key again  -> while a send is held, put it back in the editor
//
// ctx.abort() in a shortcut context is escape itself: interactive-mode binds it
// to restoreQueuedMessagesToEditor({ abort: true }), which writes the queued
// messages into the editor ahead of whatever is typed there and then stops the
// run. so the send key reads the editor after the abort, and the text it sends
// is queue-then-typed, the same text escape-then-enter would have sent. the
// queue is cleared by that call, so nothing is delivered twice.
//
// sending the newest entry alone needs its text, and pi exposes only a count
// (ExtensionContext.hasPendingMessages). lib/steering-mirror.ts rebuilds the
// queue from the input and message_start events, so that key can send one entry
// and put the rest back in the editor.
//
// a stopped run does not settle synchronously, and an extension cannot await it
// (waitForIdle is on the command context, not this one). polling ctx.isIdle()
// in the handler reported a stop that had not happened, so the send is armed
// instead and delivered from the agent_settled event. while it is armed the
// footer carries the elapsed wait and a widget line names what is pending, so a
// run that will not stop looks nothing like a run that is working.
//
// keys are configurable under [send-now] in rho.toml. ctrl+enter and
// ctrl+shift+enter carry no built-in binding, so nothing is displaced, but a
// terminal without the kitty keyboard protocol sends a bare CR for all three of
// enter, ctrl+enter, and ctrl+shift+enter, and only plain enter arrives.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import envPaths from 'env-paths';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type KeyId, Text } from '@earendil-works/pi-tui';
import type { UserMessage } from '@earendil-works/pi-ai';
import { SteeringMirror } from './lib/steering-mirror';
import { config } from './lib/config';

const STATUS_ID = 'rho-send-now';
// how often the elapsed wait in the footer is redrawn while a send is armed.
const TICK_MS = 200;
const LOG_PATH = join(envPaths('rho', { suffix: '' }).data, 'send-now.log');

/** pi joins restored queue entries with a blank line; keep that shape. */
function joinParts(parts: readonly string[]): string {
    return parts.filter((part) => part.trim() !== '').join('\n\n');
}

function trace(line: string): void {
    if (!config.sendNow.log) return;
    try {
        mkdirSync(join(LOG_PATH, '..'), { recursive: true });
        appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
    } catch {
        // a diagnostic that cannot write is not worth failing a key press over.
    }
}

/** the text pi matches a queued entry against, joined the way pi joins it. */
function userText(content: UserMessage['content']): string {
    if (typeof content === 'string') return content;
    return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

/** a send waiting for the stopped run to settle. */
interface Armed {
    readonly text: string;
    readonly at: number;
}

function preview(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 48 ? `${flat.slice(0, 45)}...` : flat;
}

export default function (pi: ExtensionAPI) {
    const mirror = new SteeringMirror();
    let armed: Armed | null = null;
    let ticker: ReturnType<typeof setInterval> | undefined;

    const stalled = (): boolean =>
        armed !== null && Date.now() - armed.at >= config.sendNow.stallWarnMs;

    const drawStatus = (ctx: ExtensionContext): void => {
        if (armed === null) return;
        const waited = ((Date.now() - armed.at) / 1000).toFixed(1);
        ctx.ui.setStatus(
            STATUS_ID,
            stalled() ? `send held, turn not stopping ${waited}s` : `send held, stopping ${waited}s`,
        );
    };

    const drawWidget = (ctx: ExtensionContext): void => {
        if (armed === null) return;
        const held = preview(armed.text);
        const colour = stalled() ? 'warning' : 'muted';
        const note = stalled()
            ? 'the turn has not stopped yet'
            : 'waiting for the turn to stop';
        ctx.ui.setWidget(STATUS_ID, (_tui, theme) =>
            new Text(theme.fg(colour, `[send-now] ${note}: ${held}`), 1, 0),
        );
    };

    const clearUi = (ctx: ExtensionContext): void => {
        if (ticker !== undefined) {
            clearInterval(ticker);
            ticker = undefined;
        }
        ctx.ui.setStatus(STATUS_ID, undefined);
        ctx.ui.setWidget(STATUS_ID, undefined);
    };

    const send = (text: string, waitedMs: number): void => {
        trace(`send waited=${waitedMs}ms chars=${text.length}`);
        pi.sendUserMessage(text, { expandPromptTemplates: true });
    };

    /** hold `text` until the stopped run settles, or send it now if it has. */
    const arm = (ctx: ExtensionContext, text: string): void => {
        if (ctx.isIdle()) {
            send(text, 0);
            return;
        }
        armed = { text, at: Date.now() };
        trace(`armed chars=${text.length}`);
        drawStatus(ctx);
        drawWidget(ctx);
        let wasStalled = false;
        ticker = setInterval(() => {
            if (armed === null) return;
            drawStatus(ctx);
            if (stalled() && !wasStalled) {
                wasStalled = true;
                drawWidget(ctx);
            }
        }, TICK_MS);
    };

    /** give the held text back to the editor and disarm. */
    const disarm = (ctx: ExtensionContext): void => {
        const held = armed;
        if (held === null) return;
        armed = null;
        clearUi(ctx);
        ctx.ui.setEditorText(joinParts([held.text, ctx.ui.getEditorText() ?? '']));
        trace(`disarmed waited=${Date.now() - held.at}ms`);
        ctx.ui.notify('send cancelled, text is back in the editor', 'info');
    };

    pi.on('session_start', () => {
        mirror.clear();
        armed = null;
    });

    pi.on('input', (event) => {
        if (event.streamingBehavior === 'steer') mirror.push(event.text);
    });

    pi.on('message_start', (event) => {
        if (event.message.role !== 'user') return;
        mirror.delivered(userText(event.message.content));
    });

    // every point the run can stall between, so a log says which one it reached.
    pi.on('agent_start', () => trace('agent_start'));
    pi.on('turn_start', () => trace('turn_start'));
    pi.on('turn_end', () => trace('turn_end'));
    pi.on('agent_end', () => trace('agent_end'));

    pi.on('agent_settled', (_event, ctx) => {
        trace(`agent_settled armed=${armed !== null}`);
        const held = armed;
        if (held === null) return;
        armed = null;
        clearUi(ctx);
        send(held.text, Date.now() - held.at);
    });

    pi.registerShortcut(config.sendNow.send as KeyId, {
        description: 'stop the current turn and send the queued and typed text now',
        handler: (ctx) => {
            if (armed !== null) {
                disarm(ctx);
                return;
            }
            trace(`send key idle=${ctx.isIdle()} pending=${ctx.hasPendingMessages()}`);
            // the abort restores the queue into the editor, so read it after.
            ctx.abort();
            const text = ctx.ui.getEditorText() ?? '';
            if (text.trim() === '') {
                ctx.ui.notify('nothing to send', 'info');
                return;
            }
            ctx.ui.setEditorText('');
            arm(ctx, text);
        },
    });

    pi.registerShortcut(config.sendNow.sendQueued as KeyId, {
        description: 'stop the current turn and send the newest queued message alone',
        handler: (ctx) => {
            if (armed !== null) {
                disarm(ctx);
                return;
            }
            mirror.reconcile(ctx.hasPendingMessages());
            const newest = mirror.newest();
            trace(`send-queued key queued=${mirror.size} idle=${ctx.isIdle()}`);
            if (newest === undefined) {
                ctx.ui.notify('nothing queued', 'info');
                return;
            }
            const typed = ctx.ui.getEditorText() ?? '';
            const rest = mirror.queued().slice(0, -1);
            ctx.abort();
            ctx.ui.setEditorText(joinParts([...rest, typed]));
            arm(ctx, newest);
        },
    });
}
