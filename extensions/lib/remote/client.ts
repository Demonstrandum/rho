/**
 * The near side: one connection to an executor, and the adapters that let pi's
 * own read, write, edit and bash tools act through it.
 *
 * The adapters matter more than they look. pi exports its tools with pluggable
 * operations, so routing a tool elsewhere is a matter of supplying different
 * operations rather than reimplementing the tool: the same argument handling,
 * the same output formatting, the same image detection, whether the file is
 * here or on a node in another country.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Decoder, encode } from './protocol';
import type { Event, Frame, ProcessId, Reply, Request } from './protocol';

export interface Connection {
    readonly name: string;
    readonly describe: string;
    request(body: Request, signal?: AbortSignal): Promise<Reply>;
    /** Output as it is produced, for a tool that wants to stream. */
    onEvent(handler: (event: Event) => void): () => void;
    close(): void;
    readonly alive: boolean;
}

class Failed extends Error {
    constructor(
        message: string,
        readonly code?: string,
    ) {
        super(message);
    }
}

const expect = <K extends Reply['kind']>(reply: Reply, kind: K): Extract<Reply, { kind: K }> => {
    if (reply.kind === 'error') throw new Failed(reply.message, reply.code);
    if (reply.kind !== kind) throw new Failed(`expected ${kind}, got ${reply.kind}`);
    return reply as Extract<Reply, { kind: K }>;
};

/**
 * A connection over a child process's stdio.
 *
 * The transport is a command, so the same code carries a local executor for
 * tests and `ssh host executor` for a rented node: the difference is argv.
 */
export function connectOverProcess(name: string, command: string, args: readonly string[]): Connection {
    const child: ChildProcess = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new Decoder();
    const waiting = new Map<number, (reply: Reply) => void>();
    const listeners = new Set<(event: Event) => void>();
    let next = 1;
    let alive = true;
    // Distinct from `alive`, because closing deliberately still has to fail
    // everything that was waiting. Guarding the drain on `alive` alone means a
    // close hangs every pending request forever, which a test caught.
    let drained = false;
    let why = '';

    // stderr is the transport's own complaint -- ssh saying the host is
    // unreachable, the binary saying it will not run -- and it is the only
    // useful thing to quote when a connection dies before it starts.
    child.stderr?.on('data', (chunk: Buffer) => {
        why += chunk.toString();
    });

    child.stdout?.on('data', (chunk: Buffer) => {
        let frames: Frame[];
        try {
            frames = decoder.push(new Uint8Array(chunk));
        } catch (error) {
            why += (error as Error).message;
            return;
        }
        for (const frame of frames) {
            if (frame.type === 'reply') {
                const settle = waiting.get(frame.id);
                waiting.delete(frame.id);
                settle?.(frame.body);
            } else if (frame.type === 'event') {
                for (const listener of listeners) listener(frame.body);
            }
        }
    });

    const die = (reason: string) => {
        if (drained) return;
        drained = true;
        alive = false;
        const message = `${name} is gone: ${reason || 'the connection closed'}`;
        // Everything still waiting fails now rather than hanging: a rented
        // node is pre-empted mid-command, and a promise that never settles
        // turns that into a session that never comes back.
        for (const [, settle] of waiting) settle({ kind: 'error', message, code: 'GONE' });
        waiting.clear();
        for (const listener of listeners) listener({ kind: 'gone', why: message });
    };

    child.on('close', (code) => die(why.trim() || `exit ${code}`));
    child.on('error', (error) => die(error.message));

    return {
        name,
        describe: `${command} ${args.join(' ')}`,
        get alive() {
            return alive;
        },
        request(body, signal) {
            if (!alive) return Promise.resolve<Reply>({ kind: 'error', message: `${name} is gone`, code: 'GONE' });
            const id = next++;
            return new Promise<Reply>((settle) => {
                waiting.set(id, settle);
                const abort = () => {
                    waiting.delete(id);
                    settle({ kind: 'error', message: 'cancelled', code: 'ABORT' });
                };
                signal?.addEventListener('abort', abort, { once: true });
                child.stdin?.write(encode({ type: 'request', id, body }));
            });
        },
        onEvent(handler) {
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        close() {
            alive = false;
            child.kill('SIGTERM');
        },
    };
}

const text = new TextDecoder();

/** The pieces pi's tools need, each one a request across the wire. */
export function operationsFor(connection: Connection) {
    const readWhole = async (path: string): Promise<Buffer> => {
        const reply = await connection.request({ kind: 'read-file', path });
        return Buffer.from(expect(reply, 'bytes').data);
    };
    const requireAccess = async (path: string): Promise<void> => {
        const reply = expect(await connection.request({ kind: 'stat', path }), 'stat');
        if (!reply.exists) throw new Failed(`no such file: ${path}`, 'ENOENT');
    };
    const writeWhole = async (path: string, content: string | Uint8Array): Promise<void> => {
        const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        expect(await connection.request({ kind: 'write-file', path, data }), 'ok');
    };

    return {
        read: {
            readFile: readWhole,
            access: requireAccess,
            // The far side has `file`; asking it costs a round trip, and the
            // answer decides whether the bytes are shown or rendered.
            detectImageMimeType: async (path: string): Promise<string | null> => {
                const probe = await connection.request({
                    kind: 'spawn',
                    command: `file --mime-type -b ${JSON.stringify(path)}`,
                });
                if (probe.kind !== 'spawned') return null;
                const finished = await waitFor(connection, probe.process);
                if (finished === null) return null;
                const out = await connection.request({
                    kind: 'read-range',
                    process: probe.process,
                    stream: 'stdout',
                    offset: 0,
                    length: 128,
                });
                void connection.request({ kind: 'release', process: probe.process });
                if (out.kind !== 'bytes') return null;
                const mime = text.decode(out.data).trim();
                return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime) ? mime : null;
            },
        },
        write: {
            writeFile: writeWhole,
            mkdir: async (directory: string): Promise<void> => {
                const made = await connection.request({
                    kind: 'spawn',
                    command: `mkdir -p ${JSON.stringify(directory)}`,
                });
                if (made.kind === 'spawned') await waitFor(connection, made.process);
            },
        },
        edit: {
            readFile: readWhole,
            access: requireAccess,
            writeFile: writeWhole,
        },
        bash: {
            exec: async (
                command: string,
                cwd: string,
                options: { onData?: (chunk: Buffer) => void; signal?: AbortSignal; timeout?: number },
            ): Promise<{ exitCode: number | null }> => {
                const started = await connection.request({
                    kind: 'spawn',
                    command,
                    cwd,
                    ...(options.timeout === undefined ? {} : { timeout: options.timeout * 1000 }),
                });
                const { process: id } = expect(started, 'spawned');

                const stop = connection.onEvent((event) => {
                    if (event.kind === 'output' && event.process === id) options.onData?.(Buffer.from(event.data));
                });
                const abort = () => void connection.request({ kind: 'signal', process: id, signal: 'KILL' });
                options.signal?.addEventListener('abort', abort, { once: true });
                try {
                    const finished = await waitFor(connection, id);
                    return { exitCode: finished?.code ?? null };
                } finally {
                    stop();
                    options.signal?.removeEventListener('abort', abort);
                    void connection.request({ kind: 'release', process: id });
                }
            },
        },
    };
}

/** Waits for one process's exit event, and gives up if the far side dies. */
export function waitFor(
    connection: Connection,
    id: ProcessId,
): Promise<Extract<Event, { kind: 'exited' }> | null> {
    return new Promise((settle) => {
        const stop = connection.onEvent((event) => {
            if (event.kind === 'exited' && event.process === id) {
                stop();
                settle(event);
            } else if (event.kind === 'gone') {
                stop();
                settle(null);
            }
        });
    });
}

export { Failed };
