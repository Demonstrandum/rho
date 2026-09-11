// Slack in and out of one session.
//
//   /slack                 status: which app, which socket, who holds what
//   /slack code-bot        attach this session to the stored app "code-bot"
//   /slack off             close the socket and release the app
//   /slack add code-bot    store an app's two tokens, prompted, never pasted
//   /slack new code-bot    print the create-app link with the manifest filled in
//   /slack drop code-bot   forget a stored app
//
// The socket lives in the session, not in a daemon: it opens when a session
// attaches and closes when that session exits. Nothing receives your DMs while
// you are not working.
//
// Credentials belong to an app and an app belongs to one session at a time,
// because Slack hands each payload to an arbitrary one of an app's open Socket
// Mode connections. Two sessions on one app would split the messages at
// random, so slack-config.ts locks an app to a session; two sessions on two
// apps are independent, which is what the named store is for.
//
// What arrives while nothing is connected is lost by Socket Mode, so each
// conversation carries a high-water mark in session state and the socket asks
// conversations.history for the gap when it opens.
//
// Why the forwarding is what it is, and the two traps behind the thread and
// the reload handling, are in extensions/slack.NOTES.md.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { PersistedState } from './lib/state-store';
import { config } from './lib/config';
import {
    type Acknowledgement,
    addressed,
    type ChannelId,
    type Identity,
    type Incoming,
    type RawMessage,
    SlackWeb,
    SocketMode,
    type Timestamp,
} from './lib/slack-api';
import {
    type AppName,
    checkName,
    createAppLink,
    listApps,
    readApp,
    readLock,
    releaseLock,
    removeApp,
    SLACK_DIR,
    summary,
    takeLock,
    TOKEN_PREFIX,
    writeApp,
} from './lib/slack-config';

const STATE_VERSION = 1;

interface SlackState {
    readonly version: typeof STATE_VERSION;
    /** the app this session attached to, reopened on a resume. */
    readonly app: AppName | null;
    /** channel -> ts of the last message handled, so a reconnect can catch up. */
    readonly marks: Record<ChannelId, Timestamp>;
    /**
     * Where the current exchange is answered.
     *
     * Held on disk rather than in memory alone because /reload replaces this
     * module mid-exchange: the reply the person is waiting for then has
     * nowhere to go and is dropped without a trace. A conversation survives a
     * reload; the answer to it should too.
     */
    readonly answering: { readonly channel: ChannelId; readonly thread: Timestamp | null } | null;
}

function parseState(raw: unknown): SlackState | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (s.version !== STATE_VERSION) return null;
    if (s.app !== null && typeof s.app !== 'string') return null;
    const a = s.answering;
    const answering =
        typeof a === 'object' && a !== null && typeof (a as { channel?: unknown }).channel === 'string'
            ? {
                  channel: (a as { channel: string }).channel,
                  thread:
                      typeof (a as { thread?: unknown }).thread === 'string'
                          ? (a as { thread: string }).thread
                          : null,
              }
            : null;
    if (typeof s.marks !== 'object' || s.marks === null) return null;
    const marks: Record<ChannelId, Timestamp> = {};
    for (const [channel, ts] of Object.entries(s.marks as Record<string, unknown>)) {
        if (typeof ts === 'string') marks[channel] = ts;
    }
    return { version: STATE_VERSION, app: s.app, marks, answering };
}

/** what the session is answering, for as long as it is answering it. */
interface Exchange {
    readonly channel: ChannelId;
    readonly thread: Timestamp | null;
    /** the first reply was forwarded as an acknowledgement. */
    ackSent: boolean;
    /** slack_reply already answered this one, so the turn's own text stays here. */
    repliedExplicitly: boolean;
}

/** an attached session's live parts, all of which die together. */
interface Attachment {
    readonly app: AppName;
    readonly web: SlackWeb;
    readonly socket: SocketMode;
    /** who the app is, for the mention guard. null until auth.test answers. */
    self: Identity | null;
}

/**
 * Slack's status line expires after two minutes, and a turn can run longer,
 * so it is set again on this interval for as long as the exchange is open.
 */
const TYPING_REFRESH_MS = 90_000;

/**
 * Where an incoming attachment lands. scratchpad.ts puts the session's scratch
 * directory in RHO_SCRATCH, and it is already the place for files that belong
 * to the session rather than to the project.
 */
const scratchDir = (): string => process.env.RHO_SCRATCH ?? tmpdir();

const acknowledgement = (): Acknowledgement | null =>
    config.slack.typing
        ? {
              emoji: config.slack.readEmoji,
              status: config.slack.loadingMessages[0] ?? 'is working on it',
              loading: config.slack.loadingMessages,
          }
        : null;

const render = (message: Incoming): string => {
    const at = new Date(Number.parseFloat(message.ts) * 1000).toISOString().slice(11, 16);
    const attached =
        message.files.length === 0
            ? ''
            : `\nFiles, already downloaded and readable at these paths:\n${message.files
                  .map((file) => `  ${file.path} (${file.name}, ${file.bytes} bytes)`)
                  .join('\n')}`;
    // Only the first and the last reply of an exchange reach Slack, so the
    // first should acknowledge rather than open the work: someone waiting on a
    // phone wants to know the message landed and then wants the answer.
    const how = [
        'Reply as a colleague would in Slack, not as a report.',
        'A one-line question gets a one-line answer. Never several paragraphs.',
        'No headings, no bullet lists, no preamble. Say the thing.',
        'Your last reply of this turn is what Slack receives; the work in between stays in the terminal.',
        'If the full detail matters, it belongs in the terminal, and Slack gets the summary plus an offer.',
        `Answer ${message.name}, and use slack_reply to write to anyone else.`,
    ].join(' ');
    return `A Slack message arrived.\n[${at} UTC] ${message.name} in ${message.channel}: ${message.text}${attached}\n\n${how}`;
};

export default function (pi: ExtensionAPI) {
    let state: PersistedState<SlackState> | null = null;
    let stored: SlackState = { version: STATE_VERSION, app: null, marks: {}, answering: null };
    let sessionId: string | null = null;
    let cwd = process.cwd();

    let attached: Attachment | null = null;
    let exchange: Exchange | null = null;
    let typingTimer: ReturnType<typeof setInterval> | null = null;
    let toolsRegistered = false;

    const save = (next: Partial<SlackState>): void => {
        stored = { ...stored, ...next };
        state?.write(stored);
    };

    const mark = (channel: ChannelId, ts: Timestamp): void => {
        save({ marks: { ...stored.marks, [channel]: ts } });
    };

    const stopTyping = (): void => {
        if (typingTimer !== null) clearInterval(typingTimer);
        typingTimer = null;
    };

    const startTyping = (channel: ChannelId, thread: Timestamp | null): void => {
        stopTyping();
        const ack = acknowledgement();
        if (ack === null || attached === null) return;
        void attached.web.setTyping(channel, thread, ack);
        typingTimer = setInterval(() => {
            if (attached === null || exchange === null) {
                stopTyping();
                return;
            }
            void attached.web.setTyping(channel, thread, ack);
        }, TYPING_REFRESH_MS);
        // A refresh timer must not hold the process open once the session ends.
        typingTimer.unref?.();
    };

    const deliver = async (message: Incoming): Promise<void> => {
        if (attached === null) return;
        mark(message.channel, message.ts);
        // The read mark first: it is the one signal that costs the sender
        // nothing to see and does not depend on the app having an assistant
        // surface.
        if (config.slack.readEmoji !== '') {
            void attached.web.react(message.channel, message.ts, config.slack.readEmoji);
        }
        startTyping(message.channel, message.threadTs);
        exchange = {
            channel: message.channel,
            thread: message.threadTs,
            ackSent: false,
            repliedExplicitly: false,
        };
        save({ answering: { channel: message.channel, thread: message.threadTs } });
        pi.sendMessage(
            { customType: 'slack', content: render(message), display: true },
            { deliverAs: 'followUp', triggerTurn: true },
        );
    };

    /**
     * What arrived while no socket was open. Socket Mode never redelivers it,
     * so every conversation this session has seen is asked directly.
     */
    const catchUp = async (): Promise<number> => {
        if (attached === null) return 0;
        let delivered = 0;
        for (const [channel, since] of Object.entries(stored.marks)) {
            const missed = await attached.web.since(channel, since, config.slack.catchUp);
            if (!missed.ok) continue;
            for (const message of missed.value) {
                await deliver(message);
                delivered += 1;
            }
        }
        return delivered;
    };

    /**
     * What is waiting in conversations this session has never seen.
     *
     * marks are per session, so a session attaching for the first time asks
     * about nothing and reports nothing missed however much is waiting. This
     * asks Slack which conversations exist and summarises the recent traffic
     * in one message, rather than replaying each one as a separate turn: an
     * inbox is for reading, and only a live message deserves an answer.
     */
    const inbox = async (): Promise<string | null> => {
        if (attached === null) return null;
        const seen = new Set(Object.keys(stored.marks));
        const found = await attached.web.conversations();
        if (!found.ok) return null;
        const fresh = found.value.filter((channel) => !seen.has(channel));
        if (fresh.length === 0) return null;

        const lines: string[] = [];
        for (const channel of fresh) {
            const recent = await attached.web.history(channel, config.slack.catchUp);
            if (!recent.ok || recent.value.length === 0) continue;
            const last = recent.value[recent.value.length - 1];
            if (last === undefined) continue;
            // Marked as read: an inbox summary is not an exchange, and the
            // next attach should not show it again.
            mark(channel, last.ts);
            const at = new Date(Number.parseFloat(last.ts) * 1000).toISOString().slice(11, 16);
            lines.push(
                `${channel} (${recent.value.length}) last [${at} UTC] ${last.name}: ${last.text.slice(0, 120)}`,
            );
        }
        if (lines.length === 0) return null;
        return [
            `Slack inbox, ${lines.length} conversation${lines.length === 1 ? '' : 's'} this session had not seen:`,
            ...lines,
            'Nothing here is addressed to you now. Use slack_read to open one, and answer only if it asks for something.',
        ].join('\n');
    };

    const registerTools = (): void => {
        if (toolsRegistered) return;
        toolsRegistered = true;

        pi.registerTool({
            name: 'slack_reply',
            label: 'Slack reply',
            description:
                'Send a message to Slack now. Use it to answer the person who wrote with something other than the reply shown in the terminal, to answer a different person, or to say something before the work is done. Without it, the last reply of a Slack-triggered turn is forwarded automatically. Keep it to a line or two, the way a colleague replies: no headings, no bullet lists, no preamble.',
            promptSnippet: 'Reply to Slack explicitly, in a line or two, instead of forwarding the whole reply',
            promptGuidelines: [
                'Use slack_reply when a turn came from Slack and the person there needs a shorter or different answer than the one in the terminal.',
                'Slack replies are short: a one-line question gets a one-line answer, and long detail stays in the terminal.',
                'Pass channel to answer someone other than the person whose message started this turn.',
            ],
            parameters: Type.Object({
                text: Type.String({ description: 'The message to send.' }),
                channel: Type.Optional(
                    Type.String({
                        description: 'Channel or user ID. Defaults to the conversation the message came from.',
                    }),
                ),
            }),
            async execute(_id, params: { text: string; channel?: string }) {
                const said = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
                if (attached === null) return said('Slack is not attached to this session.');
                const target = params.channel ?? exchange?.channel ?? null;
                if (target === null) return said('No channel: nothing has arrived from Slack, so pass one.');
                const thread = target === exchange?.channel ? (exchange?.thread ?? null) : null;
                const sent = await attached.web.post(target, params.text, thread);
                if (exchange !== null && target === exchange.channel) exchange.repliedExplicitly = true;
                return said(sent.ok ? `Sent to ${target}.` : `Slack refused it: ${sent.error}`);
            },
        });

        pi.registerTool({
            name: 'slack_send_file',
            label: 'Slack file',
            description:
                'Upload a file to Slack: an image, an archive, a log, a patch. Give a path on this machine. It goes to the conversation the current Slack message came from unless a channel is passed.',
            promptSnippet: 'Send a file to Slack',
            promptGuidelines: [
                'Use slack_send_file when the answer is a file rather than a sentence: a screenshot, an archive, a diff too long to paste.',
                'Say in one line what the file is; the comment rides with the upload.',
            ],
            parameters: Type.Object({
                path: Type.String({ description: 'Path to the file to send, absolute or relative to the working directory.' }),
                comment: Type.Optional(Type.String({ description: 'One line sent with the file.' })),
                channel: Type.Optional(
                    Type.String({ description: 'Channel or user ID. Defaults to the conversation in progress.' }),
                ),
            }),
            async execute(_id, params: { path: string; comment?: string; channel?: string }) {
                const said = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
                if (attached === null) return said('Slack is not attached to this session.');
                const target = params.channel ?? exchange?.channel ?? null;
                if (target === null) return said('No channel: nothing has arrived from Slack, so pass one.');
                const path = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);
                let bytes: Uint8Array;
                try {
                    bytes = new Uint8Array(await readFile(path));
                } catch (error) {
                    return said(`Cannot read ${path}: ${(error as Error).message}`);
                }
                const thread = target === exchange?.channel ? (exchange?.thread ?? null) : null;
                const sent = await attached.web.upload(
                    target,
                    { name: basename(path), bytes },
                    thread,
                    params.comment ?? null,
                );
                if (sent.ok && exchange !== null && target === exchange.channel) exchange.repliedExplicitly = true;
                return said(sent.ok ? `Sent ${basename(path)} to ${target}.` : `Slack refused it: ${sent.error}`);
            },
        });

        pi.registerTool({
            name: 'slack_read',
            label: 'Slack read',
            description:
                "Read a conversation's recent messages, or one thread's replies. Use it to see what was said before this session attached, to re-read a thread that has scrolled out of the conversation, or to check a channel nobody has written in yet. Reading marks the conversation read.",
            promptSnippet: 'Read past Slack messages in a conversation or a thread',
            promptGuidelines: [
                'Use slack_read when the answer depends on something said in Slack that is not in front of you.',
                'Reading a conversation is not being addressed by it: do not reply to what slack_read returns unless it asks for something.',
            ],
            parameters: Type.Object({
                channel: Type.Optional(
                    Type.String({
                        description:
                            'Channel or user ID. Defaults to the conversation the current message came from.',
                    }),
                ),
                thread: Type.Optional(
                    Type.String({
                        description:
                            "Thread timestamp, to read one thread's replies rather than the conversation itself.",
                    }),
                ),
                limit: Type.Optional(
                    Type.Integer({ minimum: 1, maximum: 200, description: 'How many messages. Default 20.' }),
                ),
            }),
            async execute(_id, params: { channel?: string; thread?: string; limit?: number }) {
                const said = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
                if (attached === null) return said('Slack is not attached to this session.');
                const target = params.channel ?? exchange?.channel ?? null;
                if (target === null) return said('No channel: nothing has arrived from Slack, so pass one.');
                const read = await attached.web.history(target, params.limit ?? 20, params.thread ?? null);
                if (!read.ok) return said(`Slack refused it: ${read.error}`);
                if (read.value.length === 0) return said(`${target} is empty.`);
                const last = read.value[read.value.length - 1];
                if (last !== undefined) mark(target, last.ts);
                const lines = read.value.map((m) => {
                    const at = new Date(Number.parseFloat(m.ts) * 1000).toISOString().slice(11, 16);
                    return `[${at} UTC] ${m.name}: ${m.text}`;
                });
                return said(`${target}, ${read.value.length} messages:\n${lines.join('\n')}`);
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
                if (exchange !== null && attached !== null) {
                    void attached.web.setTyping(exchange.channel, exchange.thread, null);
                }
                exchange = null;
                save({ answering: null });
                stopTyping();
                return { content: [{ type: 'text' as const, text: 'Slack exchange closed.' }], details: undefined };
            },
        });
    };

    /**
     * A socket outlives the session that opened it, and /reload replaces both
     * the session and this module. A module-level handle cannot reach the
     * previous copy's socket, because that copy is a different instance of
     * this file with its own variables. The handle therefore lives on
     * globalThis, the only thing the two copies share, and each load closes
     * whatever the last one left running.
     */
    const REGISTRY = '__rho_slack_attachment';
    const shared = globalThis as typeof globalThis & { [REGISTRY]?: { close: () => void } };

    const closePrevious = (): void => {
        try {
            shared[REGISTRY]?.close();
        } catch {
            // already closed
        }
        shared[REGISTRY] = undefined;
    };

    const disconnect = (forget: boolean): void => {
        stopTyping();
        exchange = null;
        const held = attached;
        attached = null;
        shared[REGISTRY] = undefined;
        if (held === null) return;
        held.socket.stop();
        if (sessionId !== null) releaseLock(held.app, sessionId);
        if (forget) save({ app: null });
    };

    type Attempt = { readonly ok: true; readonly note: string } | { readonly ok: false; readonly why: string };

    const connect = async (name: AppName, takeover: boolean): Promise<Attempt> => {
        if (sessionId === null) return { ok: false, why: 'no session id, so no app can be locked to this session' };
        const app = readApp(name);
        if (app.kind === 'unknown') {
            const known = listApps();
            const known_note = known.length === 0 ? 'no apps stored' : `stored: ${known.join(', ')}`;
            return { ok: false, why: `no app called "${name}" (${known_note}). /slack add ${name} stores one` };
        }
        if (app.kind === 'unreadable') return { ok: false, why: `${name}: ${app.why}` };

        const lock = readLock(name);
        if (lock.kind === 'held' && lock.alive && lock.lock.sessionId !== sessionId && !takeover) {
            return {
                ok: false,
                why: `${name} is held by another session (pid ${lock.lock.pid}, ${lock.lock.cwd}). /slack ${name} force takes it`,
            };
        }

        closePrevious();
        disconnect(false);
        takeLock(name, sessionId, cwd);

        const web = new SlackWeb(app.tokens.bot, join(scratchDir(), 'slack'));
        const socket = new SocketMode(app.tokens.app, {
            onMessage: (raw: RawMessage) => {
                const channel = raw.channel;
                if (channel === undefined) return;
                void (async () => {
                    if (attached === null) return;
                    const message = await attached.web.incoming(channel, raw);
                    // A DM is addressed to the app by existing. A channel
                    // message is not, and answering every line in a room the
                    // app was invited to is how a bot gets thrown out of it.
                    if (!addressed(message, attached.self)) return;
                    await deliver(message);
                })();
            },
            onState: () => {
                // A dropped socket reconnects by itself, and a session does not
                // need a notification per rotation. /slack reports the state.
            },
        });
        attached = { app: name, web, socket, self: null };
        const who = await web.identity();
        if (!who.ok) {
            disconnect(false);
            return { ok: false, why: `${name}: ${who.error}` };
        }
        attached.self = who.value;
        shared[REGISTRY] = { close: () => disconnect(false) };
        registerTools();
        socket.start();
        save({ app: name });

        const missed = await catchUp();
        const waiting = await inbox();
        if (waiting !== null) {
            pi.sendMessage({ customType: 'slack', content: waiting, display: true }, { deliverAs: 'followUp' });
        }
        const counted = missed === 0 ? '' : `, ${missed} missed`;
        return { ok: true, note: `Slack attached as ${name}${counted}.` };
    };

    const statusLines = (): readonly string[] => {
        const lines: string[] = [];
        if (attached === null) {
            lines.push('Slack: not attached to this session.');
        } else {
            const live = attached.socket.connected ? 'connected' : 'reconnecting';
            lines.push(`Slack: ${attached.app}, socket ${live}.`);
            if (exchange !== null) lines.push(`Answering in ${exchange.channel}.`);
        }
        const apps = summary();
        if (apps.length === 0) {
            lines.push(`No apps stored in ${SLACK_DIR}/apps. /slack new <name> starts one.`);
            return lines;
        }
        for (const app of apps) {
            const holder =
                app.lock.kind === 'free'
                    ? 'free'
                    : !app.lock.alive
                      ? 'free (stale lock)'
                      : app.lock.lock.sessionId === sessionId
                        ? 'this session'
                        : `pid ${app.lock.lock.pid} in ${app.lock.lock.cwd}`;
            lines.push(`  ${app.name}: ${holder}`);
        }
        return lines;
    };

    const openBrowser = (url: string): void => {
        const [command, args] =
            process.platform === 'darwin'
                ? ['open', [url]]
                : process.platform === 'win32'
                  ? ['cmd', ['/c', 'start', '', url]]
                  : ['xdg-open', [url]];
        try {
            spawn(command as string, args as string[], { stdio: 'ignore', detached: true }).unref();
        } catch {
            // no opener on this machine; the link is printed either way.
        }
    };

    /**
     * The whole setup, in one command.
     *
     * The manifest link covers app creation, the scopes, the events, and
     * Socket Mode. What no API can do is mint the two tokens: an app-level
     * token exists only once someone generates it in Basic Information, and a
     * bot token only once someone installs the app. So the command opens the
     * dialog and then waits with a prompt for each, which is two copies and
     * two pastes rather than a documentation page.
     */
    const newApp = async (name: AppName, ctx: ExtensionCommandContext): Promise<void> => {
        const link = createAppLink(name);
        openBrowser(link);
        ctx.ui.notify(
            [
                `Creating ${name}. The manifest is already filled in, so no scope has to be ticked:`,
                link,
                '',
                '1. Pick the workspace, then Create. The app settings page opens.',
                '',
                '2. App-level token, for the socket. Left sidebar -> Basic Information.',
                '   Scroll to App-Level Tokens -> Generate Token and Scopes.',
                '   Name it anything, click Add Scope -> connections:write, then Generate.',
                '   Copy the xapp- string it shows.',
                '',
                '3. Bot token, for everything else. Left sidebar -> OAuth & Permissions.',
                '   The first block is OAuth Tokens: click Install to <workspace>, then Allow.',
                '   The page comes back with Bot User OAuth Token at the top. Copy the xoxb- string.',
                '   (Scopes are already listed further down; the manifest set them.)',
                '',
                'Then paste each below. Enter on an empty prompt stores nothing.',
            ].join('\n'),
            'info',
        );
        await addApp(name, ctx);
    };

    const addApp = async (name: AppName, ctx: ExtensionCommandContext): Promise<void> => {
        // Prompted, never typed into the conversation: a token pasted as a
        // message is in the transcript, in the session file, and in the next
        // request to the model.
        const app = await ctx.ui.input(
            `${name}: app-level token, from Basic Information -> App-Level Tokens`,
            `${TOKEN_PREFIX.app}...`,
        );
        if (app === undefined || app.trim() === '') {
            ctx.ui.notify('Nothing stored.', 'info');
            return;
        }
        const bot = await ctx.ui.input(
            `${name}: bot token, from OAuth & Permissions after Install to Workspace`,
            `${TOKEN_PREFIX.bot}...`,
        );
        if (bot === undefined || bot.trim() === '') {
            ctx.ui.notify('Nothing stored.', 'info');
            return;
        }
        const tokens = { app: app.trim(), bot: bot.trim() };
        const wrong = [
            tokens.app.startsWith(TOKEN_PREFIX.app) ? null : `the app token should start ${TOKEN_PREFIX.app}`,
            tokens.bot.startsWith(TOKEN_PREFIX.bot) ? null : `the bot token should start ${TOKEN_PREFIX.bot}`,
        ].filter((problem): problem is string => problem !== null);
        if (wrong.length > 0) {
            ctx.ui.notify(`${wrong.join('; ')}. Nothing stored.`, 'error');
            return;
        }
        if (!writeApp(name, tokens)) {
            ctx.ui.notify(`Could not write ${name}.`, 'error');
            return;
        }
        // Storing an app and then not attaching it leaves the session where it
        // started, which is never what the person who just pasted two tokens
        // wanted. The lock still decides: another session holding this app
        // refuses here as it would for /slack <name>.
        const attempt = await connect(name, false);
        ctx.ui.notify(
            attempt.ok
                ? `Stored ${name}. ${attempt.note} Open a DM with ${name} in Slack and write to it.`
                : `Stored ${name}, not attached: ${attempt.why}`,
            attempt.ok ? 'info' : 'warning',
        );
    };

    /**
     * Reattach on a bare /reload, not only on a session start.
     *
     * /reload builds a fresh copy of this file but does not fire session_start,
     * so a repair that lives only there never runs: the socket stays owned by
     * the copy that was replaced, and Slack goes quiet while the lock still
     * looks healthy. Anything holding a lock under this very process is this
     * session by definition, whatever id the lock remembers.
     */
    const reattachAfterReload = async (): Promise<void> => {
        const id = process.env.PI_SESSION_ID ?? null;
        if (id === null) return;
        for (const name of listApps()) {
            const lock = readLock(name);
            if (lock.kind !== 'held' || lock.lock.pid !== process.pid) continue;
            if (lock.lock.sessionId === id && attached !== null) return;
            sessionId = id;
            closePrevious();
            await connect(name, true);
            return;
        }
    };
    // After the factory returns, so registerCommand and registerTool have run.
    setTimeout(() => void reattachAfterReload(), 0);

    pi.on('session_start', async (_event, ctx) => {
        cwd = ctx.cwd;
        sessionId = ctx.sessionManager.getSessionId();
        state = PersistedState.open({ name: 'slack', scope: 'session', parse: parseState }, { cwd, sessionId });
        stored = state.read() ?? stored;
        closePrevious();
        // An exchange interrupted by a reload is resumed, not abandoned: the
        // person asked a question and is still waiting for the answer, and a
        // reply with no target is dropped silently.
        if (stored.answering !== null) {
            exchange = {
                channel: stored.answering.channel,
                thread: stored.answering.thread,
                ackSent: false,
                repliedExplicitly: false,
            };
        }
        // A resume gives the session a new id, and the state is per session,
        // so the new id starts blank and nothing reconnects: the app stays
        // locked to an id that no longer exists and Slack goes quiet with
        // everything still looking attached. The lock is what survives, so a
        // lock held by this very process is inherited.
        if (stored.app === null && sessionId !== null) {
            for (const name of listApps()) {
                const lock = readLock(name);
                if (lock.kind === 'held' && lock.lock.pid === process.pid) {
                    stored = { ...stored, app: name };
                    break;
                }
            }
        }
        if (!config.slack.reconnect || stored.app === null) return;
        const resumed = await connect(stored.app, true);
        if (ctx.hasUI) ctx.ui.notify(resumed.ok ? resumed.note : `Slack: ${resumed.why}`, resumed.ok ? 'info' : 'warning');
    });

    pi.on('session_shutdown', async () => disconnect(false));

    // The last reply of a turn is the answer, so it goes to Slack. Every turn
    // before it ended because tool calls came back, which is narration: sending
    // those turns one question into a stream of updates, which is what the read
    // mark and the status line replace.
    pi.on('turn_end', async (event) => {
        if (attached === null || exchange === null) return;
        const content = (event as { message?: { content?: unknown } }).message?.content;
        const text = Array.isArray(content)
            ? content
                  .filter(
                      (part): part is { type: string; text: string } =>
                          typeof part === 'object' &&
                          part !== null &&
                          (part as { type?: string }).type === 'text',
                  )
                  .map((part) => part.text)
                  .join('\n')
                  .trim()
            : typeof content === 'string'
              ? content.trim()
              : '';
        const working = ((event as { toolResults?: unknown[] }).toolResults?.length ?? 0) > 0;

        if (working) {
            if (config.slack.ackMessage && !exchange.ackSent && text !== '' && !exchange.repliedExplicitly) {
                await attached.web.post(exchange.channel, text, exchange.thread);
                exchange.ackSent = true;
            }
            return;
        }

        if (text !== '' && !exchange.repliedExplicitly) {
            await attached.web.post(exchange.channel, text, exchange.thread);
        } else {
            // Slack clears the status when the app posts; when it did not post,
            // the status has to be cleared by hand or it hangs for two minutes.
            void attached.web.setTyping(exchange.channel, exchange.thread, null);
        }
        exchange = null;
        save({ answering: null });
        stopTyping();
    });

    pi.registerCommand('slack', {
        description: 'attach this session to a stored Slack app: /slack <app>, /slack off, /slack add <app>',
        getArgumentCompletions: (prefix) => {
            const verbs = ['off', 'add', 'new', 'drop'];
            const candidates = [...listApps(), ...verbs].filter((word) => word.startsWith(prefix));
            return candidates.length > 0 ? candidates.map((word) => ({ value: word, label: word })) : null;
        },
        handler: async (args, ctx) => {
            const [verb = '', argument = '', modifier = ''] = args.trim().split(/\s+/);

            if (verb === '') {
                for (const line of statusLines()) ctx.ui.notify(line, 'info');
                return;
            }

            if (verb === 'off' || verb === 'disconnect') {
                if (attached === null) {
                    ctx.ui.notify('Slack is not attached to this session.', 'info');
                    return;
                }
                const was = attached.app;
                disconnect(true);
                ctx.ui.notify(`Slack released: ${was}.`, 'info');
                return;
            }

            if (verb === 'add' || verb === 'new' || verb === 'drop') {
                const checked = checkName(argument);
                if (!checked.ok) {
                    ctx.ui.notify(`/slack ${verb} <name>: ${checked.why}`, 'error');
                    return;
                }
                if (verb === 'add') {
                    await addApp(checked.name, ctx);
                    return;
                }
                if (verb === 'new') {
                    await newApp(checked.name, ctx);
                    return;
                }
                if (attached?.app === checked.name) disconnect(true);
                ctx.ui.notify(removeApp(checked.name) ? `Dropped ${checked.name}.` : `Could not drop ${checked.name}.`, 'info');
                return;
            }

            const checked = checkName(verb);
            if (!checked.ok) {
                ctx.ui.notify(`/slack <app>: ${checked.why}`, 'error');
                return;
            }
            const result = await connect(checked.name, argument === 'force' || modifier === 'force');
            ctx.ui.notify(result.ok ? result.note : result.why, result.ok ? 'info' : 'error');
        },
    });
}
