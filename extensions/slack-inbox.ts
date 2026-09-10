/**
 * Slack messages into the session.
 *
 * bin/slack-inbox holds the Socket Mode connection and appends each message to
 * ~/.config/robotics-migration/slack-inbox.jsonl. This reads that file: whatever
 * arrived while no session was open is delivered at startup, and anything that
 * arrives during a session is injected as it lands, with a turn triggered so an
 * idle agent picks it up rather than waiting to be prompted.
 *
 * A cursor beside the spool records how far the file has been read, so the same
 * message is not delivered twice across sessions.
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const CONFIG = join(homedir(), '.config', 'robotics-migration');
const SPOOL = join(CONFIG, 'slack-inbox.jsonl');
const CURSOR = join(CONFIG, 'slack-inbox.cursor');
const BOT_TOKEN = join(CONFIG, 'slack-bot-token');

/** Slack's limit is 40000 characters; a long reply is cut rather than dropped. */
const LIMIT = 3500;

const post = async (
    channel: string,
    text: string,
    threadTs?: string | null,
): Promise<string | null> => {
    const token = fs.readFileSync(BOT_TOKEN, 'utf8').trim();
    const body =
        text.length > LIMIT ? `${text.slice(0, LIMIT)}\n[...truncated]` : text;
    const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
            channel,
            text: body,
            ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
    });
    const out = (await res.json()) as { ok: boolean; error?: string };
    return out.ok ? null : (out.error ?? 'unknown error');
};

interface Entry {
    ts: string;
    channel: string;
    thread_ts?: string | null;
    user: string;
    name: string;
    text: string;
}

const readCursor = (): number => {
    try {
        return Number.parseInt(fs.readFileSync(CURSOR, 'utf8').trim(), 10) || 0;
    } catch {
        return 0;
    }
};

const writeCursor = (n: number): void => {
    fs.writeFileSync(CURSOR, `${n}\n`, { mode: 0o600 });
};

/** Entries after the cursor, and the new cursor to record. */
const unread = (): { entries: Entry[]; cursor: number } => {
    let lines: string[];
    try {
        lines = fs.readFileSync(SPOOL, 'utf8').split('\n').filter(Boolean);
    } catch {
        return { entries: [], cursor: readCursor() };
    }
    const from = readCursor();
    const entries: Entry[] = [];
    for (const line of lines.slice(from)) {
        try {
            entries.push(JSON.parse(line) as Entry);
        } catch {
            // a half-written line; the next read picks it up
        }
    }
    return { entries, cursor: lines.length };
};

/**
 * Where a reply belongs, read from the spool rather than from what this
 * session delivered. A message received before this copy of the extension
 * loaded still has a thread, and a reply posted without that thread lands in
 * the channel body, which an assistant app's DM view does not show.
 */
const lastTarget = (): { channel: string; thread: string | null } | null => {
    try {
        const lines = fs.readFileSync(SPOOL, 'utf8').split('\n').filter(Boolean);
        const last = lines[lines.length - 1];
        if (!last) return null;
        const e = JSON.parse(last) as Entry;
        return { channel: e.channel, thread: e.thread_ts ?? null };
    } catch {
        return null;
    }
};

const render = (entries: Entry[]): string => {
    const when = (ts: string) =>
        new Date(Number.parseFloat(ts) * 1000).toISOString().slice(11, 16);
    const lines = entries.map(
        (e) => `[${when(e.ts)} UTC] ${e.name} in ${e.channel}: ${e.text}`,
    );
    const head =
        entries.length === 1
            ? 'A Slack message arrived:'
            : `${entries.length} Slack messages arrived:`;
    // Only the first and the last reply of an exchange reach Slack, so the
    // first should be an acknowledgement rather than the start of the work:
    // someone waiting on a phone wants to know the message landed, and gets
    // nothing else until there is an answer.
    const how =
        'Answer in one short line first, before any tool calls, so the sender knows it arrived. Then do the work and give the result in your final reply; anything in between stays in the terminal.';
    return `${head}\n${lines.join('\n')}\n\n${how}`;
};

export default function (pi: ExtensionAPI) {
    // The channel a Slack-triggered turn should answer to, and whether the
    // answer has already been sent by hand. Both are cleared once a turn ends.
    let replyTo: string | null = null;
    let replyThread: string | null = null;
    let repliedExplicitly = false;
    // A turn ends every time tool calls come back, so a long job produces a
    // run of them. Forwarding each one turns a single question into a stream
    // of narration in Slack. Only two are worth sending: the first, so the
    // person knows the message arrived, and the last, which is the answer.
    let ackSent = false;
    let done = false;

    pi.registerTool({
        name: 'slack_reply',
        label: 'Slack reply',
        description:
            'Send a message to Slack. Use it to answer a Slack message with something other than the reply shown in the terminal, or to write to a different channel. Without it, the reply to a Slack-triggered turn is forwarded automatically.',
        promptSnippet: 'Reply to Slack explicitly instead of forwarding the whole reply',
        promptGuidelines: [
            'Use slack_reply when a turn came from Slack and the person there needs a shorter or different answer than the one in the terminal.',
        ],
        parameters: Type.Object({
            text: Type.String({ description: 'The message to send.' }),
            channel: Type.Optional(
                Type.String({
                    description:
                        'Channel or user ID. Defaults to the conversation the message came from.',
                }),
            ),
        }),
        async execute(_id, params: { text: string; channel?: string }) {
            const said = (text: string) => ({
                content: [{ type: 'text' as const, text }],
                details: undefined,
            });
            const fallback = lastTarget();
            const target = replyTo ?? fallback?.channel ?? null;
            const channel = params.channel ?? target;
            if (!channel) {
                return said('No channel: nothing has arrived from Slack, so pass one.');
            }
            const thread =
                channel === target ? (replyThread ?? fallback?.thread ?? null) : null;
            const failure = await post(channel, params.text, thread);
            if (channel === target) repliedExplicitly = true;
            return said(failure ? `Slack refused it: ${failure}` : `Sent to ${channel}.`);
        },
    });

    pi.registerTool({
        name: 'slack_done',
        label: 'Slack done',
        description:
            'Stop forwarding replies to Slack for the current exchange. Use it after the Slack side has the answer and the remaining work is only of interest in the terminal.',
        promptSnippet: 'End the Slack exchange so further replies stay in the terminal',
        promptGuidelines: [
            'Use slack_done once a Slack question has been answered and the rest of the work does not need reporting there.',
        ],
        parameters: Type.Object({}),
        async execute() {
            done = true;
            replyTo = null;
            replyThread = null;
            return {
                content: [{ type: 'text' as const, text: 'Slack exchange closed.' }],
                details: undefined,
            };
        },
    });

    // Whatever the turn ends up saying goes back to Slack, so a message there
    // always gets an answer without the agent having to remember to send one.
    pi.on('turn_end', async (event) => {
        if (done) return;
        if (replyTo === null && !repliedExplicitly) {
            // The message may have been delivered before this copy of the
            // extension loaded, so the spool decides where it goes.
            const fallback = lastTarget();
            if (fallback && fallback.thread) {
                replyTo = fallback.channel;
                replyThread = fallback.thread;
            }
        }
        if (!replyTo || repliedExplicitly) {
            replyTo = null;
            repliedExplicitly = false;
            return;
        }
        const content = (event as { message?: { content?: unknown } }).message?.content;
        const text = Array.isArray(content)
            ? content
                  .filter((c): c is { type: string; text: string } =>
                      typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text',
                  )
                  .map((c) => c.text)
                  .join('\n')
                  .trim()
            : typeof content === 'string'
              ? content.trim()
              : '';
        // Tool results mean the work is still going: this is narration, not
        // an answer. The first one is sent anyway, as an acknowledgement, and
        // the exchange stays open for the answer that follows.
        const working =
            ((event as { toolResults?: unknown[] }).toolResults?.length ?? 0) > 0;
        if (working) {
            if (!ackSent && text) {
                await post(replyTo, text, replyThread);
                ackSent = true;
            }
            return;
        }

        if (text) await post(replyTo, text, replyThread);
        replyTo = null;
        replyThread = null;
        repliedExplicitly = false;
        ackSent = false;
    });

    // A watcher outlives the session that started it, and /reload replaces
    // both the session and this module. A module-level handle cannot close the
    // previous instance's watcher, because that instance is a different copy
    // of this file with its own variables. The handle therefore lives on
    // globalThis, which is the only thing the two copies share, and each load
    // closes whatever the last one left running.
    const REGISTRY = '__rho_slack_inbox_watcher';
    const shared = globalThis as typeof globalThis & {
        [REGISTRY]?: { close: () => void };
    };

    const stopPrevious = () => {
        try {
            shared[REGISTRY]?.close();
        } catch {
            // already closed
        }
        shared[REGISTRY] = undefined;
    };

    stopPrevious();
    pi.on('session_shutdown', async () => stopPrevious());

    pi.on('session_start', async (_event, ctx) => {
        stopPrevious();

        const deliver = (why: 'waiting' | 'live') => {
            const { entries, cursor } = unread();
            if (entries.length === 0) return;
            // Answers go to whoever wrote last.
            const last = entries[entries.length - 1];
            replyTo = last?.channel ?? null;
            replyThread = last?.thread_ts ?? null;
            repliedExplicitly = false;
            ackSent = false;
            done = false;
            pi.sendMessage(
                {
                    customType: 'slack-inbox',
                    content: render(entries),
                    display: true,
                },
                { deliverAs: 'followUp', triggerTurn: true },
            );
            // Only once the session has accepted them, so a delivery into a
            // replaced session leaves the messages to be read by the next one.
            writeCursor(cursor);
            if (ctx.hasUI) {
                ctx.ui.notify(
                    `${entries.length} Slack message${entries.length === 1 ? '' : 's'} (${why})`,
                    'info',
                );
            }
        };

        // Anything that landed while pi was closed.
        deliver('waiting');

        // fs.watch needs the file to exist, and it will not on a fresh machine.
        try {
            fs.mkdirSync(CONFIG, { recursive: true, mode: 0o700 });
            if (!fs.existsSync(SPOOL)) fs.writeFileSync(SPOOL, '', { mode: 0o600 });
        } catch {
            return;
        }

        // Editors and appenders both fire several events per write, so the
        // read is debounced rather than run per event.
        let pending: ReturnType<typeof setTimeout> | undefined;
        const fsWatcher = fs.watch(SPOOL, () => {
            if (pending) clearTimeout(pending);
            pending = setTimeout(() => {
                try {
                    deliver('live');
                } catch {
                    // This session is gone. The cursor was not advanced, so
                    // the next one delivers what arrived.
                    stopPrevious();
                }
            }, 400);
        });

        shared[REGISTRY] = {
            close: () => {
                if (pending) clearTimeout(pending);
                fsWatcher.close();
            },
        };
    });
}
