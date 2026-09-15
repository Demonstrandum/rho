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
import { connect as netConnect } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { Decoder, encode } from './protocol';
import type { Event, Frame, ProcessId, Reply, Request } from './protocol';

export interface Connection {
    readonly name: string;
    readonly describe: string;
    /** `timeoutMs` of 0 waits indefinitely; omitted means the default deadline. */
    request(body: Request, signal?: AbortSignal, timeoutMs?: number): Promise<Reply>;
    /** Output as it is produced, for a tool that wants to stream. */
    onEvent(handler: (event: Event) => void): () => void;
    /** An exit that has already been seen, so waiting for it cannot hang. */
    exited(id: ProcessId): Extract<Event, { kind: 'exited' }> | undefined;
    close(): void;
    readonly alive: boolean;
}

/** Long enough for a slow link and a busy machine, short enough to notice. */
const DEFAULT_TIMEOUT_MS = 20_000;

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
 * What a transport has to provide, and nothing more.
 *
 * A child process's stdio is one; a unix socket is another, and that is how a
 * session reaches back to the machine its interface is running on. The framing,
 * the request table and the death handling are the same either way, so they are
 * written once and the transport is these four members.
 */
export interface Carrier {
    readonly describe: string;
    write(bytes: Uint8Array): void;
    /** Called with each chunk, with the complaint stream, and once when it ends. */
    listen(handlers: { data: (chunk: Uint8Array) => void; complaint: (text: string) => void; ended: (why: string) => void }): void;
    close(): void;
}

/** A connection over a child process's stdio. */
export function connectOverProcess(name: string, command: string, args: readonly string[]): Connection {
    const child: ChildProcess = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    return connectOver(name, {
        describe: `${command} ${args.join(' ')}`,
        write: (bytes) => void child.stdin?.write(bytes),
        listen: ({ data, complaint, ended }) => {
            child.stdout?.on('data', (chunk: Buffer) => data(new Uint8Array(chunk)));
            child.stderr?.on('data', (chunk: Buffer) => complaint(chunk.toString()));
            child.on('close', (code) => ended(`exit ${code}`));
            child.on('error', (error) => ended(error.message));
        },
        close: () => void child.kill('SIGTERM'),
    });
}

/**
 * A connection over a unix socket.
 *
 * ssh can carry a unix socket in either direction, so a session on a server can
 * hold one of these onto the machine somebody is sitting at: the socket is
 * forwarded when the interface attaches and goes when it leaves, which is what
 * a laptop is -- reachable while you are there.
 */
export function connectOverSocket(name: string, path: string): Connection {
    const socket = netConnect(path);
    return connectOver(name, {
        describe: path,
        write: (bytes) => void socket.write(bytes),
        listen: ({ data, ended }) => {
            socket.on('data', (chunk: Buffer) => data(new Uint8Array(chunk)));
            socket.on('close', () => ended('the socket closed'));
            socket.on('error', (error: Error) => ended(error.message));
        },
        close: () => socket.destroy(),
    });
}

/** The framing and the request table, over whichever transport carries bytes. */
function connectOver(name: string, carrier: Carrier): Connection {
    const decoder = new Decoder();
    const waiting = new Map<number, (reply: Reply) => void>();
    const listeners = new Set<(event: Event) => void>();
    /** Recent exits, so a process that finished before anyone waited is not waited for forever. */
    const exits = new Map<ProcessId, Extract<Event, { kind: 'exited' }>>();
    let next = 1;
    let alive = true;
    // Distinct from `alive`, because closing deliberately still has to fail
    // everything that was waiting. Guarding the drain on `alive` alone means a
    // close hangs every pending request forever, which a test caught.
    let drained = false;
    let why = '';

    const arrived = (chunk: Uint8Array) => {
        let frames: Frame[];
        try {
            frames = decoder.push(chunk);
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
                if (frame.body.kind === 'exited') {
                    exits.set(frame.body.process, frame.body);
                    // Bounded: this is a race guard, not a history.
                    if (exits.size > 256) exits.delete(exits.keys().next().value as ProcessId);
                }
                for (const listener of listeners) listener(frame.body);
            }
        }
    };

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

    carrier.listen({
        data: arrived,
        // The transport's own complaint -- ssh saying the host is unreachable,
        // the binary saying it will not run -- is the only useful thing to
        // quote when a connection dies before it starts.
        complaint: (said) => {
            why += said;
        },
        ended: (reason) => die(why.trim() || reason),
    });

    return {
        name,
        describe: carrier.describe,
        get alive() {
            return alive;
        },
        request(body, signal, timeoutMs) {
            if (!alive) return Promise.resolve<Reply>({ kind: 'error', message: `${name} is gone`, code: 'GONE' });
            const id = next++;
            return new Promise<Reply>((settle) => {
                // Every request has a deadline, and the default is not "none".
                // The far side may be unreachable, attached to somebody else,
                // or wedged, and none of those send a reply: a request that
                // waits for ever turns any of them into a session that hangs
                // with nothing on screen. A long-running command is not an
                // exception, because the request that starts it returns as
                // soon as it has started.
                const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS;
                const timer =
                    limit <= 0
                        ? null
                        : setTimeout(() => {
                              waiting.delete(id);
                              settle({
                                  kind: 'error',
                                  message: `${name} did not answer in ${Math.round(limit / 1000)}s`,
                                  code: 'TIMEOUT',
                              });
                          }, limit);
                waiting.set(id, (reply) => {
                    if (timer !== null) clearTimeout(timer);
                    settle(reply);
                });
                const abort = () => {
                    waiting.delete(id);
                    if (timer !== null) clearTimeout(timer);
                    settle({ kind: 'error', message: 'cancelled', code: 'ABORT' });
                };
                signal?.addEventListener('abort', abort, { once: true });
                carrier.write(encode({ type: 'request', id, body }));
            });
        },
        onEvent(handler) {
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        exited(id) {
            return exits.get(id);
        },
        close() {
            alive = false;
            carrier.close();
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
                // The tool hands us the directory the session was started in,
                // which is a path on the laptop and means nothing here. Passing
                // it on makes the spawn fail with ENOENT naming the shell,
                // because that is what posix_spawn reports for a missing
                // working directory. The executor's own directory is the one
                // the person set with /cwd, so it is left alone.
                void cwd;
                const started = await connection.request({
                    kind: 'spawn',
                    command,
                    ...(options.timeout === undefined ? {} : { timeout: options.timeout * 1000 }),
                });
                const { process: id } = expect(started, 'spawned');

                // Counted, because the far side keeps everything and the
                // stream is only for showing progress: bytes produced before
                // this listener exists would otherwise be lost, which is how a
                // fast command came back with an exit code and no output.
                let streamed = { stdout: 0, stderr: 0 };
                const stop = connection.onEvent((event) => {
                    if (event.kind !== 'output' || event.process !== id) return;
                    streamed[event.stream] += event.data.byteLength;
                    options.onData?.(Buffer.from(event.data));
                });
                const abort = () => void connection.request({ kind: 'signal', process: id, signal: 'KILL' });
                options.signal?.addEventListener('abort', abort, { once: true });
                try {
                    const finished = await waitFor(connection, id);
                    if (finished !== null) {
                        // Whatever the stream missed, read back from the far
                        // side, so the output is the process's, not the
                        // network's timing.
                        for (const stream of ['stdout', 'stderr'] as const) {
                            const total = stream === 'stdout' ? finished.stdoutBytes : finished.stderrBytes;
                            if (total <= streamed[stream]) continue;
                            const rest = await connection.request({
                                kind: 'read-range',
                                process: id,
                                stream,
                                offset: streamed[stream],
                                length: total - streamed[stream],
                            });
                            if (rest.kind === 'bytes' && rest.data.byteLength > 0) {
                                options.onData?.(Buffer.from(rest.data));
                            }
                        }
                    }
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
    // A short command can finish before this is called, and an exit that has
    // already happened is not sent again: waiting for it then never returns,
    // which is a session that hangs rather than a command that failed. The
    // connection remembers recent exits for exactly this.
    const already = connection.exited(id);
    if (already !== undefined) return Promise.resolve(already);
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
