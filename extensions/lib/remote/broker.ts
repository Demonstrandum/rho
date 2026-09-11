/**
 * The broker: a named agent session that outlives the thing looking at it.
 *
 * `ssh host pi` ties the session to the connection, so closing the laptop ends
 * it and two windows are two sessions. The broker owns `pi --mode rpc` on the
 * always-on host instead: clients attach and detach, the session carries on
 * between them, and everything attached sees the same one.
 *
 * It runs on the host, started over ssh by the laptop, and speaks the same
 * framed protocol as the executor -- a client comes and goes, the far side
 * holds the long-lived thing, and output is read rather than pushed in full.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer, connect as connectSocket } from 'node:net';
import type { Server, Socket } from 'node:net';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decoder, encode } from './protocol';
import type { Frame } from './protocol';

/** One socket per named session, under the user's runtime directory. */
export const SOCKETS = join(process.env.HOME ?? '/tmp', '.cache', 'rho', 'sessions');

const socketFor = (name: string): string => join(SOCKETS, `${name}.sock`);
/**
 * Beside the socket, because stopping a session cannot go through the socket:
 * that carries the agent's own protocol, and inventing a control message
 * inside it would mean a prompt containing that message could kill the
 * session.
 */
const pidFor = (name: string): string => join(SOCKETS, `${name}.pid`);

/**
 * What a client gets when it attaches part way through.
 *
 * Enough of the recent stream to draw something, rather than the whole
 * history: the session file on disk holds all of it, and shipping a megabyte
 * of JSON to redraw a screen is the thing this design exists to avoid.
 */
const REPLAY = 200;

export interface Session {
    readonly name: string;
    readonly started: Date;
    readonly clients: number;
    readonly alive: boolean;
}

/**
 * Runs on the host. Owns one agent process, fans its events out to whoever is
 * attached, and forwards what they send back into it.
 */
export class Broker {
    private readonly agent: ChildProcess;
    private readonly clients = new Set<Socket>();
    private readonly recent: Buffer[] = [];
    private server: Server | null = null;
    private ended = false;

    constructor(
        readonly name: string,
        command: string,
        args: readonly string[],
        readonly cwd: string,
    ) {
        this.agent = spawn(command, [...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

        // pi's RPC mode is JSONL, so a line is the unit worth keeping and
        // replaying. Partial lines are held: half an event redraws nothing.
        let held = '';
        this.agent.stdout?.on('data', (chunk: Buffer) => {
            held += chunk.toString();
            const lines = held.split('\n');
            held = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const bytes = Buffer.from(`${line}\n`);
                this.remember(bytes);
                this.broadcast(bytes);
            }
        });
        this.agent.stderr?.on('data', (chunk: Buffer) => this.broadcast(chunk));
        this.agent.on('close', () => {
            this.ended = true;
            for (const client of this.clients) client.end();
            this.server?.close();
            try {
                rmSync(socketFor(this.name), { force: true });
                rmSync(pidFor(this.name), { force: true });
            } catch {
                // already gone
            }
        });
    }

    private remember(line: Buffer): void {
        this.recent.push(line);
        if (this.recent.length > REPLAY) this.recent.shift();
    }

    private broadcast(bytes: Buffer): void {
        for (const client of this.clients) client.write(bytes);
    }

    listen(): void {
        mkdirSync(SOCKETS, { recursive: true });
        const path = socketFor(this.name);
        // A socket left by a dead broker would refuse the bind. Nothing is
        // listening on it, so removing it is safe; a live one is caught by
        // `existing` below before we get here.
        rmSync(path, { force: true });
        this.server = createServer((client) => {
            this.clients.add(client);
            // The buffer is history, and a client that cannot tell it from
            // live events answers the last question again: it is bracketed so
            // a viewer can draw it as what already happened.
            if (this.recent.length > 0) {
                client.write(`${JSON.stringify({ type: 'rho_replay_start' })}\n`);
                for (const line of this.recent) client.write(line);
                client.write(`${JSON.stringify({ type: 'rho_replay_end' })}\n`);
            }
            client.on('data', (chunk: Buffer) => this.agent.stdin?.write(chunk));
            const drop = () => this.clients.delete(client);
            client.on('close', drop);
            client.on('error', drop);
        });
        this.server.listen(path);
        writeFileSync(pidFor(this.name), `${process.pid}\n`);
    }

    stop(): void {
        this.agent.kill('SIGTERM');
    }

    get state(): Session {
        return { name: this.name, started: new Date(), clients: this.clients.size, alive: !this.ended };
    }
}

/** Is something listening on this name's socket, or is it a leftover? */
export function existing(name: string): Promise<boolean> {
    return new Promise((settle) => {
        const socket = connectSocket(socketFor(name));
        socket.on('connect', () => {
            socket.destroy();
            settle(true);
        });
        socket.on('error', () => settle(false));
    });
}

/**
 * End a session by name. Returns false if nothing was running under it.
 */
export function stop(name: string): boolean {
    let pid: number;
    try {
        pid = Number.parseInt(readFileSync(pidFor(name), 'utf8').trim(), 10);
    } catch {
        return false;
    }
    if (!Number.isFinite(pid)) return false;
    try {
        process.kill(pid, 'SIGTERM');
        return true;
    } catch {
        // The broker is already gone; clear what it left behind.
        rmSync(socketFor(name), { force: true });
        rmSync(pidFor(name), { force: true });
        return false;
    }
}

export function named(): readonly string[] {
    try {
        return readdirSync(SOCKETS)
            .filter((file) => file.endsWith('.sock'))
            .map((file) => file.slice(0, -'.sock'.length));
    } catch {
        return [];
    }
}

/**
 * The client end, running on the laptop: stdio in, stdio out, so it can be
 * driven through `ssh host rho-session attach <name>` and the RPC stream comes
 * back unchanged.
 */
export function attach(name: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
    return new Promise((settle, fail) => {
        const socket = connectSocket(socketFor(name));
        socket.on('connect', () => {
            // `{ end: false }` because a viewer that stops sending is still
            // watching: the default ends the socket when stdin does, so piping
            // one command in and waiting for the answer disconnects before the
            // answer arrives.
            input.pipe(socket, { end: false });
            socket.pipe(output);
        });
        socket.on('close', () => settle());
        socket.on('error', (error) => fail(new Error(`no session called ${name}: ${error.message}`)));
    });
}

/** Frames, for talking to a broker over the same protocol the executor uses. */
export function frame(bytes: Buffer): Frame {
    return { type: 'event', body: { kind: 'output', process: 'agent', stream: 'stdout', data: new Uint8Array(bytes) } };
}

export { Decoder, encode };

/** Is a session's directory still there? A session whose cwd is gone cannot resume. */
export function usable(cwd: string): boolean {
    try {
        return statSync(cwd).isDirectory();
    } catch {
        return false;
    }
}
