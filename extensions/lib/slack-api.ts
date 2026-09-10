// the Slack calls this needs, and the Socket Mode connection that feeds them.
//
// no SDK. the surface is nine Web API methods and one WebSocket, and the SDK
// costs five packages, a Node engine constraint, and its own reconnect policy.
//
// files go both ways. an incoming attachment is behind a URL that needs the
// bot token, so it is fetched once and written to the session's scratch
// directory, where the ordinary file tools can read it. an outgoing one takes
// the external upload dance (a URL from Slack, a POST of the bytes, a complete
// call that attaches it to a conversation), because files.upload is retired.
//
// every call returns a Result rather than throwing: a Slack failure is an
// ordinary outcome (a revoked token, a bot removed from a conversation, a rate
// limit) and the caller decides what to say about it, in a session that must
// not die because Slack said no.
//
// in a subdirectory so extension auto-discovery (top-level *.ts only) does not
// load it as an extension.

import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

/** Slack timestamps are strings ("1731000000.000100") and order lexically within a channel. */
export type Timestamp = string;
export type ChannelId = string;
export type UserId = string;

/** where a message came from, which decides whether it is answered unprompted. */
export type ConversationKind = 'im' | 'mpim' | 'channel' | 'group' | 'unknown';

/** an attachment, already on disk. Slack's own URL needs the bot token to read, so it is fetched once. */
export interface SavedFile {
    readonly name: string;
    readonly path: string;
    readonly bytes: number;
}

export interface Incoming {
    readonly channel: ChannelId;
    readonly kind: ConversationKind;
    readonly ts: Timestamp;
    /** the thread to answer in, or null for a conversation that is not threaded. */
    readonly threadTs: Timestamp | null;
    readonly user: UserId;
    /** display name where users:read allowed one, the id otherwise. */
    readonly name: string;
    readonly text: string;
    readonly files: readonly SavedFile[];
}

/** who the app is, which is what a mention in a channel has to match. */
export interface Identity {
    readonly userId: UserId;
    readonly team: string;
}

/** every method this module calls, so a typo is a compile error rather than an `unknown_method` at runtime. */
type Method =
    | 'apps.connections.open'
    | 'auth.test'
    | 'chat.postMessage'
    | 'conversations.history'
    | 'conversations.replies'
    | 'users.conversations'
    | 'files.completeUploadExternal'
    | 'files.getUploadURLExternal'
    | 'reactions.add'
    | 'users.info'
    | 'agents.sessions.setStatus'
    | 'assistant.threads.setStatus';

interface Envelope {
    ok: boolean;
    error?: string;
}

/**
 * How the agent tells the sender it is working.
 *
 * `read` is a reaction on the incoming message, which is the only read mark
 * Slack offers an app. `typing` is the status line under the conversation,
 * rendered as "<app name> is thinking...", which Slack clears when the app
 * posts and expires by itself after two minutes.
 */
export interface Acknowledgement {
    readonly emoji: string;
    readonly status: string;
    readonly loading: readonly string[];
}

export class SlackWeb {
    private readonly names = new Map<UserId, string>();
    /**
     * agents.sessions.setStatus replaces assistant.threads.setStatus, and an
     * app that predates the agent surface only answers to the older one. The
     * first call settles which, and the rest of the session follows it.
     */
    private statusMethod: 'agents.sessions.setStatus' | 'assistant.threads.setStatus' | 'none' | 'unknown' = 'unknown';

    /**
     * @param token the bot token
     * @param downloads where an incoming attachment is written, normally the
     *   session scratch directory, so the ordinary file tools can read it
     */
    constructor(
        private readonly token: string,
        private readonly downloads: string,
    ) {}

    private async call<T>(method: Method, body: Record<string, unknown>): Promise<Result<T & Envelope>> {
        let response: Response;
        // Slack's read methods reject a JSON body with invalid_arguments and
        // want form encoding; the write methods take either. Form is the one
        // shape that works for both, so everything goes out that way.
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
            if (value === undefined || value === null) continue;
            // Arrays and objects are JSON inside a form field: files.complete
            // UploadExternal takes a files array, and String() on that is
            // "[object Object]", which Slack rejects as invalid_arguments.
            form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
        try {
            response = await fetch(`https://slack.com/api/${method}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
                },
                body: form.toString(),
            });
        } catch (error) {
            return fail(`${method}: ${(error as Error).message}`);
        }
        let payload: T & Envelope;
        try {
            payload = (await response.json()) as T & Envelope;
        } catch {
            return fail(`${method}: HTTP ${response.status}, unreadable body`);
        }
        return payload.ok ? ok(payload) : fail(payload.error ?? `${method}: unknown error`);
    }

    /** Slack accepts 40000 characters; a longer reply is cut rather than refused. */
    private static readonly LIMIT = 3500;

    async post(channel: ChannelId, text: string, threadTs: Timestamp | null): Promise<Result<Timestamp>> {
        const body = text.length > SlackWeb.LIMIT ? `${text.slice(0, SlackWeb.LIMIT)}\n[...truncated]` : text;
        const sent = await this.call<{ ts?: Timestamp }>('chat.postMessage', {
            channel,
            text: body,
            ...(threadTs === null ? {} : { thread_ts: threadTs }),
        });
        return sent.ok ? ok(sent.value.ts ?? '') : sent;
    }

    /** who the app is. The mention guard needs it, and it is the one call that proves the token works. */
    async identity(): Promise<Result<Identity>> {
        const who = await this.call<{ user_id?: UserId; team?: string }>('auth.test', {});
        if (!who.ok) return who;
        return ok({ userId: who.value.user_id ?? '', team: who.value.team ?? '' });
    }

    /**
     * Send a file.
     *
     * files.upload is retired, so this is the three-step external upload: ask
     * for a URL, POST the bytes to it, then attach the file to a conversation.
     * The bytes go to the URL Slack returns, not to slack.com/api, and that
     * POST is the only one here that is not JSON.
     */
    async upload(
        channel: ChannelId,
        file: { readonly name: string; readonly bytes: Uint8Array },
        threadTs: Timestamp | null,
        comment: string | null,
    ): Promise<Result<void>> {
        const slot = await this.call<{ upload_url?: string; file_id?: string }>('files.getUploadURLExternal', {
            filename: file.name,
            length: file.bytes.byteLength,
        });
        if (!slot.ok) return slot;
        const url = slot.value.upload_url;
        const id = slot.value.file_id;
        if (url === undefined || id === undefined) return fail('files.getUploadURLExternal: no upload url');

        const form = new FormData();
        form.append('file', new Blob([file.bytes]), file.name);
        try {
            const put = await fetch(url, { method: 'POST', body: form });
            if (!put.ok) return fail(`upload: HTTP ${put.status}`);
        } catch (error) {
            return fail(`upload: ${(error as Error).message}`);
        }

        const done = await this.call('files.completeUploadExternal', {
            files: [{ id, title: file.name }],
            channel_id: channel,
            ...(threadTs === null ? {} : { thread_ts: threadTs }),
            ...(comment === null || comment === '' ? {} : { initial_comment: comment }),
        });
        return done.ok ? ok(undefined) : done;
    }

    /**
     * Fetch an incoming attachment to disk.
     *
     * `url_private` is not public: it answers only to the bot token, and to a
     * browser it answers with a login page, so a path on disk is the only form
     * of the file the rest of the session can use.
     */
    private async saveFile(file: RawFile): Promise<SavedFile | null> {
        const url = file.url_private_download ?? file.url_private;
        if (url === undefined) return null;
        const name = basename(file.name ?? file.id ?? 'attachment').replace(/[/\\]/g, '_');
        try {
            const response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!response.ok) return null;
            const bytes = new Uint8Array(await response.arrayBuffer());
            mkdirSync(this.downloads, { recursive: true });
            // The Slack file id keeps two files of the same name apart, and it
            // is stable, so a redelivered message overwrites rather than piles up.
            const path = join(this.downloads, file.id === undefined ? name : `${file.id}-${name}`);
            await writeFile(path, bytes);
            return { name, path, bytes: bytes.byteLength };
        } catch {
            return null;
        }
    }

    /** the read mark. `already_reacted` is success: the point is that the emoji is there. */
    async react(channel: ChannelId, ts: Timestamp, emoji: string): Promise<Result<void>> {
        const added = await this.call('reactions.add', { channel, timestamp: ts, name: emoji });
        if (added.ok || added.error.endsWith('already_reacted')) return ok(undefined);
        return added;
    }

    /**
     * The typing line. Empty text clears it.
     *
     * Under the agent messaging experience this also opens the thread for the
     * user, so it is only called when a reply into that thread is coming.
     */
    async setTyping(
        channel: ChannelId,
        threadTs: Timestamp | null,
        ack: Acknowledgement | null,
    ): Promise<Result<void>> {
        if (threadTs === null || this.statusMethod === 'none') return ok(undefined);
        const body = {
            channel_id: channel,
            thread_ts: threadTs,
            status: ack === null ? '' : ack.status,
            ...(ack === null || ack.loading.length === 0 ? {} : { loading_messages: ack.loading.slice(0, 10) }),
        };
        const order: readonly ('agents.sessions.setStatus' | 'assistant.threads.setStatus')[] =
            this.statusMethod === 'unknown'
                ? ['agents.sessions.setStatus', 'assistant.threads.setStatus']
                : [this.statusMethod];
        let last: Result<unknown> = fail('no status method');
        for (const method of order) {
            last = await this.call(method, body);
            if (last.ok) {
                this.statusMethod = method;
                return ok(undefined);
            }
        }
        // A plain bot has no assistant surface and never will during this
        // session, so stop asking rather than spending a call per message.
        if (this.statusMethod === 'unknown') this.statusMethod = 'none';
        return last.ok ? ok(undefined) : fail(last.error);
    }

    /**
     * What arrived in a conversation after `after`.
     *
     * This is the catch-up: Socket Mode delivers nothing that was sent while
     * no socket was open, so a session that starts, or reconnects, asks for
     * the gap directly.
     */
    async since(channel: ChannelId, after: Timestamp, limit = 50): Promise<Result<readonly Incoming[]>> {
        const history = await this.call<{ messages?: readonly RawMessage[] }>('conversations.history', {
            channel,
            oldest: after,
            inclusive: false,
            limit,
        });
        if (!history.ok) return history;
        const messages = history.value.messages ?? [];
        const human = messages.filter((m) => m.bot_id === undefined && typeof m.user === 'string' && !m.subtype);
        // Slack returns newest first; a conversation reads the other way.
        const chronological = [...human].reverse();
        const out: Incoming[] = [];
        for (const m of chronological) out.push(await this.incoming(channel, m));
        return ok(out);
    }

    /**
     * The conversations this app can see, newest activity first.
     *
     * A session that has never been attached has no marks, so `since` has
     * nothing to ask about and reports no missed messages however many are
     * waiting. This is what it asks instead.
     */
    async conversations(limit = 50): Promise<Result<readonly ChannelId[]>> {
        type Listed = { channels?: readonly { readonly id?: string; readonly is_archived?: boolean }[] };
        const ask = (types: string) =>
            this.call<Listed>('users.conversations', { types, exclude_archived: true, limit });
        // An app installed before channels:read and groups:read were in the
        // manifest has neither, and asking for channel types it cannot see
        // fails the whole call rather than returning the DMs it can. DMs are
        // where a session is reached, so they are worth having alone.
        let list = await ask('im,mpim,public_channel,private_channel');
        if (!list.ok && list.error.includes('missing_scope')) list = await ask('im,mpim');
        if (!list.ok) return list;
        const ids = (list.value.channels ?? [])
            .filter((c) => c.is_archived !== true && typeof c.id === 'string')
            .map((c) => c.id as ChannelId);
        return ok(ids);
    }

    /**
     * The last `limit` messages of a conversation, oldest first. `thread` asks
     * for one thread's replies rather than the conversation body, which is
     * where an assistant app's DMs live.
     */
    async history(
        channel: ChannelId,
        limit = 20,
        thread: Timestamp | null = null,
    ): Promise<Result<readonly Incoming[]>> {
        const method = thread === null ? 'conversations.history' : 'conversations.replies';
        const args = thread === null ? { channel, limit } : { channel, ts: thread, limit };
        const page = await this.call<{ messages?: readonly RawMessage[] }>(method, args);
        if (!page.ok) return page;
        const messages = page.value.messages ?? [];
        // conversations.history returns newest first, conversations.replies
        // oldest first, so only the former is reversed.
        const chronological = thread === null ? [...messages].reverse() : [...messages];
        const out: Incoming[] = [];
        for (const m of chronological) {
            if (m.subtype !== undefined) continue;
            out.push(await this.incoming(channel, m));
        }
        return ok(out);
    }

    async incoming(channel: ChannelId, raw: RawMessage): Promise<Incoming> {
        const user = raw.user ?? '';
        const saved: SavedFile[] = [];
        for (const file of raw.files ?? []) {
            const on_disk = await this.saveFile(file);
            if (on_disk !== null) saved.push(on_disk);
        }
        return {
            channel,
            kind: conversationKind(raw),
            files: saved,
            ts: raw.ts ?? String(Date.now() / 1000),
            // An assistant app's DMs arrive in a thread, and a reply without
            // this lands in the conversation body, which the sender's view
            // does not show. Where there is no thread, the message itself is
            // the root of one.
            threadTs: raw.thread_ts ?? raw.ts ?? null,
            user,
            name: await this.displayName(user),
            text: raw.text ?? '',
        };
    }

    private async displayName(user: UserId): Promise<string> {
        if (user === '') return 'someone';
        const known = this.names.get(user);
        if (known !== undefined) return known;
        const info = await this.call<{ user?: { name?: string; profile?: { display_name?: string; real_name?: string } } }>(
            'users.info',
            { user },
        );
        const profile = info.ok ? info.value.user?.profile : undefined;
        const name =
            (profile?.display_name !== undefined && profile.display_name !== '' ? profile.display_name : undefined) ??
            profile?.real_name ??
            (info.ok ? info.value.user?.name : undefined) ??
            user;
        this.names.set(user, name);
        return name;
    }
}

/** the fields of an attached file this reads; Slack sends many more. */
export interface RawFile {
    id?: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private?: string;
    url_private_download?: string;
}

/** the fields of a Slack message this reads; Slack sends many more. */
export interface RawMessage {
    ts?: Timestamp;
    thread_ts?: Timestamp;
    user?: UserId;
    text?: string;
    bot_id?: string;
    subtype?: string;
    channel?: ChannelId;
    channel_type?: string;
    type?: string;
    files?: readonly RawFile[];
}

/**
 * Slack labels a DM `im`, a group DM `mpim`, a public channel `channel`, and a
 * private one `group`. History has no such field, so a message read back
 * through conversations.history is `unknown` and is treated as a DM, which is
 * the only kind whose history this asks for.
 */
function conversationKind(raw: RawMessage): ConversationKind {
    switch (raw.channel_type) {
        case 'im':
            return 'im';
        case 'mpim':
            return 'mpim';
        case 'channel':
            return 'channel';
        case 'group':
            return 'group';
        default:
            return 'unknown';
    }
}

/** whether a message is addressed to this app, which is what a channel requires and a DM does not. */
export function addressed(message: Incoming, self: Identity | null): boolean {
    if (message.kind === 'im' || message.kind === 'mpim' || message.kind === 'unknown') return true;
    if (self === null) return false;
    return message.text.includes(`<@${self.userId}>`);
}

interface Frame {
    type?: 'hello' | 'events_api' | 'interactive' | 'slash_commands' | 'disconnect';
    envelope_id?: string;
    reason?: string;
    payload?: { event?: RawMessage };
    connection_info?: { app_id?: string };
}

export type SocketState = 'connecting' | 'open' | 'closed';

export interface SocketHandlers {
    readonly onMessage: (raw: RawMessage) => void;
    readonly onState: (state: SocketState, detail: string | null) => void;
}

/**
 * One Socket Mode connection, reconnected until told to stop.
 *
 * Slack rotates these sockets by design and sends a `disconnect` frame before
 * dropping one, so a close is a reconnect, not a failure. The caller holding
 * this object is a single pi session: Slack sends each payload to an arbitrary
 * one of an app's open connections, so a second connected session would take a
 * random half of the messages. The lock in slack-config.ts is what prevents it.
 */
export class SocketMode {
    private socket: WebSocket | null = null;
    private stopped = false;
    private retry = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly appToken: string,
        private readonly handlers: SocketHandlers,
    ) {}

    start(): void {
        this.stopped = false;
        void this.connect();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        const socket = this.socket;
        this.socket = null;
        try {
            socket?.close();
        } catch {
            // already gone
        }
        this.handlers.onState('closed', null);
    }

    get connected(): boolean {
        return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    }

    private schedule(): void {
        if (this.stopped) return;
        // 1s, 2s, 4s, ..., 30s. Slack drops sockets routinely, and a tight
        // loop against a revoked token is a rate limit.
        const wait = Math.min(30_000, 1000 * 2 ** this.retry);
        this.retry += 1;
        this.timer = setTimeout(() => void this.connect(), wait);
    }

    private async connect(): Promise<void> {
        if (this.stopped) return;
        this.handlers.onState('connecting', null);
        let url: string;
        try {
            const response = await fetch('https://slack.com/api/apps.connections.open', {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.appToken}` },
            });
            const body = (await response.json()) as { ok: boolean; url?: string; error?: string };
            if (!body.ok || body.url === undefined) throw new Error(body.error ?? 'no url');
            url = body.url;
        } catch (error) {
            this.handlers.onState('closed', `connect failed: ${(error as Error).message}`);
            this.schedule();
            return;
        }

        const socket = new WebSocket(url);
        this.socket = socket;

        socket.addEventListener('open', () => {
            this.retry = 0;
        });

        socket.addEventListener('message', (event: MessageEvent) => {
            let frame: Frame;
            try {
                frame = JSON.parse(String(event.data)) as Frame;
            } catch {
                return;
            }
            // Slack redelivers anything unacknowledged, three times, so
            // acknowledge before doing anything that can throw.
            if (frame.envelope_id !== undefined) {
                try {
                    socket.send(JSON.stringify({ envelope_id: frame.envelope_id }));
                } catch {
                    // the socket went away mid-frame; the reconnect handles it
                }
            }
            if (frame.type === 'hello') {
                this.handlers.onState('open', frame.connection_info?.app_id ?? null);
                return;
            }
            if (frame.type === 'disconnect') return;
            const message = frame.payload?.event;
            if (message === undefined || message.type !== 'message' || message.subtype !== undefined) return;
            // The app's own messages come back down the socket; passing them
            // on would have the agent answer itself.
            if (message.bot_id !== undefined || message.user === undefined) return;
            this.handlers.onMessage(message);
        });

        const reconnect = (detail: string | null) => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.handlers.onState('closed', detail);
            this.schedule();
        };
        socket.addEventListener('close', () => reconnect(null));
        socket.addEventListener('error', () => reconnect('socket error'));
    }
}
