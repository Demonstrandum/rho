/**
 * The far side: one process on the machine the work happens on.
 *
 * It exists because prefixing every command with ssh loses everything between
 * commands. A `cd` does not survive, an exported variable does not survive, a
 * background process is orphaned, and each call pays a new connection. This
 * holds a working directory, an environment and a process table for as long as
 * the connection lasts, and it keeps command output where it was produced so a
 * 40 MB log is a byte count until somebody asks for a range of it.
 *
 * It speaks the protocol on stdin and stdout, so the transport can be ssh, a
 * local pipe for tests, or anything else that carries bytes. It is compiled to
 * a single executable with `bun build --compile`, so a rented node needs no
 * runtime, no package manager and no root to run it.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Decoder, encode, PROTOCOL_VERSION } from './protocol';
import type { Event, Frame, ProcessId, Reply, Request } from './protocol';

interface Held {
    readonly child: ChildProcess;
    readonly stdout: Uint8Array[];
    readonly stderr: Uint8Array[];
    stdoutBytes: number;
    stderrBytes: number;
    exited: boolean;
}

/**
 * A shell that exists on this machine.
 *
 * `bash` is not a path, and NixOS has no /bin/bash: a non-login connection can
 * arrive with no PATH at all, and then spawning "bash" fails with ENOENT. The
 * login shell is asked first because it is what the person would have got,
 * then PATH, then /bin/sh, which the standard requires to exist.
 */
const shell = (): string => {
    const candidates: string[] = [];
    const login = process.env.SHELL;
    if (login !== undefined && login !== '') candidates.push(login);
    for (const dir of (process.env.PATH ?? '').split(':')) {
        if (dir !== '') candidates.push(join(dir, 'bash'));
    }
    candidates.push('/run/current-system/sw/bin/bash', '/usr/bin/bash', '/bin/bash', '/bin/sh');
    for (const candidate of candidates) {
        try {
            accessSync(candidate, fsConstants.X_OK);
            return candidate;
        } catch {
            // not this one
        }
    }
    return '/bin/sh';
};

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
};

export class Executor {
    private readonly processes = new Map<ProcessId, Held>();
    private next = 1;
    private cwd: string;

    constructor(
        private readonly send: (frame: Frame) => void,
        cwd: string = process.cwd(),
    ) {
        this.cwd = cwd;
    }

    /** Relative paths resolve against the connection's directory, not the process's. */
    private at(path: string): string {
        return isAbsolute(path) ? path : resolve(this.cwd, path);
    }

    private emit(event: Event): void {
        this.send({ type: 'event', body: event });
    }

    async handle(id: number, request: Request): Promise<void> {
        let body: Reply;
        try {
            body = await this.run(request);
        } catch (error) {
            const failure = error as NodeJS.ErrnoException;
            body = { kind: 'error', message: failure.message, ...(failure.code ? { code: failure.code } : {}) };
        }
        this.send({ type: 'reply', id, body });
    }

    private async run(request: Request): Promise<Reply> {
        switch (request.kind) {
            case 'ping':
                return { kind: 'pong', version: PROTOCOL_VERSION, host: hostname(), cwd: this.cwd };

            case 'chdir': {
                const target = this.at(request.path);
                const info = await stat(target);
                if (!info.isDirectory()) return { kind: 'error', message: `not a directory: ${target}` };
                this.cwd = target;
                return { kind: 'cwd', path: this.cwd };
            }

            case 'cwd':
                return { kind: 'cwd', path: this.cwd };

            case 'spawn':
                return this.spawn(request);

            case 'stdin': {
                const held = this.processes.get(request.process);
                if (held === undefined) return { kind: 'error', message: `no such process: ${request.process}` };
                held.child.stdin?.write(request.data);
                return { kind: 'ok' };
            }

            case 'signal': {
                const held = this.processes.get(request.process);
                if (held === undefined) return { kind: 'error', message: `no such process: ${request.process}` };
                held.child.kill(`SIG${request.signal}`);
                return { kind: 'ok' };
            }

            case 'read-range': {
                const held = this.processes.get(request.process);
                if (held === undefined) return { kind: 'error', message: `no such process: ${request.process}` };
                const whole =
                    request.stream === 'stdout'
                        ? concat(held.stdout, held.stdoutBytes)
                        : concat(held.stderr, held.stderrBytes);
                const from = Math.max(0, Math.min(request.offset, whole.byteLength));
                const to = Math.min(from + request.length, whole.byteLength);
                return { kind: 'bytes', data: whole.slice(from, to), eof: to >= whole.byteLength };
            }

            case 'release':
                this.processes.delete(request.process);
                return { kind: 'ok' };

            case 'read-file': {
                const bytes = await readFile(this.at(request.path));
                const from = request.offset ?? 0;
                const to = request.length === undefined ? bytes.byteLength : from + request.length;
                const slice = new Uint8Array(bytes.subarray(from, Math.min(to, bytes.byteLength)));
                return { kind: 'bytes', data: slice, eof: to >= bytes.byteLength };
            }

            case 'write-file': {
                const target = this.at(request.path);
                await mkdir(join(target, '..'), { recursive: true });
                await writeFile(target, request.data, request.mode === undefined ? {} : { mode: request.mode });
                return { kind: 'ok' };
            }

            case 'edit-file':
                return this.edit(request);

            case 'stat': {
                const target = this.at(request.path);
                try {
                    const info = await stat(target);
                    return {
                        kind: 'stat',
                        exists: true,
                        directory: info.isDirectory(),
                        bytes: info.size,
                        mode: info.mode & 0o777,
                    };
                } catch {
                    return { kind: 'stat', exists: false, directory: false, bytes: 0, mode: 0 };
                }
            }

            case 'list': {
                const names = await readdir(this.at(request.path));
                const pattern = request.glob;
                if (pattern === undefined) return { kind: 'names', names };
                // A glob, not a regex: * and ? only, anchored, everything else literal.
                const expression = new RegExp(
                    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
                );
                return { kind: 'names', names: names.filter((name) => expression.test(name)) };
            }
        }
    }

    private spawn(request: Extract<Request, { kind: 'spawn' }>): Reply {
        const id = `p${this.next++}`;
        let child: ChildProcess;
        try {
            child = spawn(shell(), ['-lc', request.command], {
                cwd: request.cwd === undefined ? this.cwd : this.at(request.cwd),
                env: { ...process.env, ...request.env },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            // A command that cannot start is one failed command. Letting this
            // throw took the whole executor down, so a typo destroyed the
            // environment and everything it was holding.
            return { kind: 'error', message: `could not start a shell: ${(error as Error).message}` };
        }
        const held: Held = { child, stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, exited: false };
        this.processes.set(id, held);

        // Kept here and streamed at the same time: the stream is so a slow
        // command is not silent, the copy is so the whole of it can be asked
        // for later without rerunning anything.
        const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
            const bytes = new Uint8Array(chunk);
            if (stream === 'stdout') {
                held.stdout.push(bytes);
                held.stdoutBytes += bytes.byteLength;
            } else {
                held.stderr.push(bytes);
                held.stderrBytes += bytes.byteLength;
            }
            this.emit({ kind: 'output', process: id, stream, data: bytes });
        };
        child.stdout?.on('data', collect('stdout'));
        child.stderr?.on('data', collect('stderr'));

        // Same again for an asynchronous failure: reported as the command
        // ending badly, never as the connection dying.
        child.on('error', (error) => {
            const message = `${error.message}\n`;
            const bytes = new TextEncoder().encode(message);
            held.stderr.push(bytes);
            held.stderrBytes += bytes.byteLength;
            this.emit({ kind: 'output', process: id, stream: 'stderr', data: bytes });
            if (!held.exited) {
                held.exited = true;
                this.emit({
                    kind: 'exited',
                    process: id,
                    code: 127,
                    signal: null,
                    stdoutBytes: held.stdoutBytes,
                    stderrBytes: held.stderrBytes,
                });
            }
        });

        const timer =
            request.timeout === undefined
                ? undefined
                : setTimeout(() => child.kill('SIGKILL'), request.timeout);

        child.on('close', (code, signal) => {
            if (timer !== undefined) clearTimeout(timer);
            held.exited = true;
            this.emit({
                kind: 'exited',
                process: id,
                code,
                signal,
                stdoutBytes: held.stdoutBytes,
                stderrBytes: held.stderrBytes,
            });
        });

        return { kind: 'spawned', process: id };
    }

    private async edit(request: Extract<Request, { kind: 'edit-file' }>): Promise<Reply> {
        const target = this.at(request.path);
        await access(target, constants.R_OK | constants.W_OK);
        let text = await readFile(target, 'utf8');
        for (const edit of request.edits) {
            const first = text.indexOf(edit.old);
            if (first === -1) return { kind: 'error', message: `no match for edit in ${target}` };
            // Uniqueness is the contract of an exact-match edit: two matches
            // mean the caller did not say which one, and guessing corrupts a
            // file on a machine nobody is watching.
            if (text.indexOf(edit.old, first + 1) !== -1) {
                return { kind: 'error', message: `edit matches more than once in ${target}` };
            }
            text = `${text.slice(0, first)}${edit.new}${text.slice(first + edit.old.length)}`;
        }
        await writeFile(target, text);
        return { kind: 'ok' };
    }

    /** Kill everything still running. A node that goes away should not leave work behind. */
    shutdown(): void {
        for (const held of this.processes.values()) {
            if (!held.exited) held.child.kill('SIGKILL');
        }
        this.processes.clear();
    }
}

/** The entry point of the compiled binary: protocol on stdin and stdout. */
export function serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Executor {
    const decoder = new Decoder();
    const executor = new Executor((frame) => output.write(encode(frame)));
    input.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(new Uint8Array(chunk))) {
            if (frame.type === 'request') void executor.handle(frame.id, frame.body);
        }
    });
    input.on('close', () => executor.shutdown());
    return executor;
}
