// One notebook on one server: its kernel session, and a live view of it.
//
// marimo's editor holds one session per notebook file, and the session is the
// kernel: the namespace, the graph, the outputs. A browser creates it by
// opening a websocket with a session id and the file; a second editor
// connection to the same file is demoted to a viewer while the first is open.
// So the agent takes care over which kind of connection it holds:
//
//   creating   when no session exists for the file, open an editor socket,
//              instantiate the notebook (run every cell), then close it. The
//              session stays: marimo keeps orphaned sessions until told not
//              to, and the next browser that opens the file resumes this one,
//              kernel state and all, rather than starting a second.
//   watching   a kiosk socket (`kiosk=true`) receives every operation the
//              kernel emits without claiming the editor's seat. It feeds the
//              mirror, which is what the status line and the tools read for
//              cell states between calls.
//   acting     code runs through the HTTP execute endpoint, which names the
//              session in a header. The id is looked up by file path on each
//              call, since marimo renames a session when a browser resumes it.
//
// A person opening the notebook in a browser therefore joins the same kernel
// the agent is working in, and neither one is read-only.

import { randomUUID } from 'node:crypto';
import {
    execute,
    instantiate,
    interrupt,
    kernelStatus,
    listSessions,
    serverToken,
    trimSlash,
    type Execution,
    type ServerAddress,
} from './client';
import { NotebookMirror } from './mirror';

const READY_TIMEOUT_MS = 30_000;
/**
 * how long an open waits for the first run before answering anyway. a
 * notebook that trains a model on open is still a notebook to look at, and
 * the table says which cells are running.
 */
export const OPEN_RUN_WAIT_MS = 45_000;
const RUN_SETTLE_MS = 300;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000];

const wsUrl = (address: ServerAddress, params: Record<string, string>): string => {
    const base = trimSlash(address.url).replace(/^http/, 'ws');
    const query = new URLSearchParams(params);
    if (address.token !== undefined && address.token !== '') query.set('access_token', address.token);
    return `${base}/ws?${query.toString()}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** open a socket and resolve once the kernel says it is ready, or reject. */
function connect(url: string, mirror: NotebookMirror, onClose: () => void): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        let ready = false;
        const timer = setTimeout(() => {
            if (!ready) {
                socket.close();
                reject(new Error(`the kernel did not report ready within ${READY_TIMEOUT_MS / 1000}s`));
            }
        }, READY_TIMEOUT_MS);
        socket.onmessage = (event) => {
            let message: unknown;
            try {
                message = JSON.parse(String(event.data));
            } catch {
                return;
            }
            mirror.apply(message);
            if (!ready && (message as { op?: string }).op === 'kernel-ready') {
                ready = true;
                clearTimeout(timer);
                resolve(socket);
            }
        };
        socket.onerror = () => {
            if (!ready) {
                clearTimeout(timer);
                reject(new Error(`could not open a websocket to ${url}`));
            }
        };
        socket.onclose = (event) => {
            clearTimeout(timer);
            if (!ready) reject(new Error(`the server closed the socket (${event.code} ${event.reason || 'no reason'})`));
            else onClose();
        };
    });
}

export class NotebookSession {
    readonly mirror = new NotebookMirror();
    private kiosk: WebSocket | null = null;
    private closed = false;
    private sessionId: string | null = null;
    private readonly listeners = new Set<() => void>();
    /** set when the session was created here rather than found. */
    created = false;

    private constructor(
        readonly address: ServerAddress,
        /** absolute path of the notebook file. */
        readonly path: string,
    ) {}

    /**
     * Attach to the notebook's session on the server, creating and running
     * it when there is none. `run` says whether a created session runs its
     * cells; a found one is left as it is.
     */
    static async attach(address: ServerAddress, path: string, run = true): Promise<NotebookSession> {
        const session = new NotebookSession(address, path);
        if (address.serverToken === undefined) await serverToken(address);
        const existing = await session.lookup();
        if (existing === null) {
            await session.create(run);
            session.created = true;
        }
        await session.watch();
        return session;
    }

    /** the current session id for this file on the server, or null. */
    private async lookup(): Promise<string | null> {
        const sessions = await listSessions(this.address);
        const match = sessions.find((s) => s.path === this.path || s.filename === this.path);
        this.sessionId = match?.id ?? null;
        return this.sessionId;
    }

    private async create(run: boolean): Promise<void> {
        const id = `rho-${randomUUID().slice(0, 8)}`;
        const editor = await connect(wsUrl(this.address, { session_id: id, file: this.path }), this.mirror, () => undefined);
        try {
            await instantiate(this.address, id, run);
            this.sessionId = id;
            if (run) await this.settle(OPEN_RUN_WAIT_MS);
        } finally {
            editor.close();
            // marimo marks the session orphaned when the socket goes; give it
            // the tick, or the kiosk that follows can race the bookkeeping.
            await sleep(150);
        }
        this.sessionId = id;
    }

    private async watch(): Promise<void> {
        if (this.closed) return;
        const id = `rho-watch-${randomUUID().slice(0, 8)}`;
        const url = wsUrl(this.address, { session_id: id, file: this.path, kiosk: 'true' });
        this.kiosk = await connect(url, this.mirror, () => void this.rewatch());
        this.kiosk.onmessage = (event) => {
            try {
                this.mirror.apply(JSON.parse(String(event.data)));
            } catch {
                return;
            }
            for (const listener of this.listeners) listener();
        };
    }

    private async rewatch(): Promise<void> {
        this.kiosk = null;
        if (this.closed) return;
        for (const delay of RECONNECT_DELAYS_MS) {
            await sleep(delay);
            if (this.closed) return;
            try {
                if ((await this.lookup()) === null) continue;
                await this.watch();
                return;
            } catch {
                // the server may be mid-restart; try again after the next delay
            }
        }
        for (const listener of this.listeners) listener();
    }

    /** called on every kernel message, for status lines. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    get watching(): boolean {
        return this.kiosk !== null && this.kiosk.readyState === WebSocket.OPEN;
    }

    /** wait for the kernel to go idle, up to a limit. */
    async settle(timeoutMs: number, signal?: AbortSignal): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        // the mirror sees `running` from the editor socket during create and
        // from the kiosk afterwards; the status endpoint is the fallback when
        // neither has said anything yet.
        await sleep(RUN_SETTLE_MS);
        while (Date.now() < deadline && signal?.aborted !== true) {
            if (this.mirror.running === 0) {
                const id = this.sessionId ?? (await this.lookup());
                if (id === null) return;
                const state = await kernelStatus(this.address, id);
                if (state !== 'running') return;
            }
            await sleep(200);
        }
    }

    /** what the kernel is running now, by cell id. */
    get busyWith(): string[] {
        return this.mirror.list().filter((c) => c.status === 'running' || c.status === 'queued').map((c) => c.id);
    }

    /** stop whatever the kernel is running. */
    async interrupt(): Promise<void> {
        const id = this.sessionId ?? (await this.lookup());
        if (id !== null) await interrupt(this.address, id);
    }

    /**
     * run code in the scratchpad, with a fresh look at which session the file has.
     *
     * the kernel is one thread: code sent while a cell runs waits for it, and
     * a request dropped while waiting interrupts the kernel, cell and all. so
     * a busy kernel is given `busyWaitMs` to finish and then declined, rather
     * than joined and later cut short.
     */
    async execute(code: string, signal?: AbortSignal, timeoutMs?: number, busyWaitMs = 20_000): Promise<Execution> {
        let id = this.sessionId ?? (await this.lookup());
        if (id === null) throw new Error(`no session for ${this.path} on ${this.address.url}; open it again`);
        if (this.busyWith.length > 0) {
            await this.settle(busyWaitMs, signal);
            const still = this.busyWith;
            if (still.length > 0) {
                return {
                    ok: false,
                    stdout: '',
                    stderr: `the kernel is busy running ${still.join(', ')}; code waits behind a running cell. try again when it finishes, or interrupt it first.`,
                    result: '',
                    ms: busyWaitMs,
                };
            }
        }
        let result = await execute(this.address, id, code, signal, timeoutMs);
        // a browser resumed the session under a new id between calls: the
        // old id gets a 4xx or an empty stream. look it up once and retry.
        if (!result.ok && result.stdout === '' && /answered 4\d\d|without a result|session/i.test(result.stderr)) {
            const fresh = await this.lookup();
            if (fresh !== null && fresh !== id) {
                id = fresh;
                result = await execute(this.address, id, code, signal, timeoutMs);
            }
        }
        return result;
    }

    /** the browser url a person opens to join. */
    get browserUrl(): string {
        const query = new URLSearchParams({ file: this.path });
        if (this.address.token !== undefined && this.address.token !== '') query.set('access_token', this.address.token);
        return `${trimSlash(this.address.url)}/?${query.toString()}`;
    }

    close(): void {
        this.closed = true;
        this.kiosk?.close();
        this.kiosk = null;
        this.listeners.clear();
    }
}
