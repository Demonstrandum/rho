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

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer, connect as connectSocket } from 'node:net';
import type { Server, Socket } from 'node:net';

/** `c3|r1`: which client asked, and what it called the question. */
const TAG = /^(c\d+)\|(.+)$/;
import { mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * What a session is, beside the socket you talk to it through.
 *
 * A name alone does not say where the session is working, so a list of them
 * could not tell a project's worktree from a home directory. The broker knows
 * both and writes them down where anything enumerating sessions can read them
 * without connecting.
 */
const metaFor = (name: string): string => join(SOCKETS, `${name}.json`);

export interface SessionFacts {
    readonly name: string;
    readonly cwd: string;
    readonly pid: number;
    readonly started: string;
}

export function facts(name: string): SessionFacts | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(metaFor(name), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return null;
        const held = parsed as Partial<SessionFacts>;
        if (typeof held.cwd !== 'string' || typeof held.pid !== 'number') return null;
        return { name, cwd: held.cwd, pid: held.pid, started: held.started ?? '' };
    } catch {
        return fromProcess(name);
    }
}

/**
 * The directory of a broker that started before it wrote one down.
 *
 * A session outlives the code that started it, so an upgrade leaves running
 * sessions with no note beside their socket. The process itself still knows,
 * and on the machines this runs on that is a readable link.
 */
function fromProcess(name: string): SessionFacts | null {
    try {
        const pid = Number.parseInt(readFileSync(pidFor(name), 'utf8').trim(), 10);
        if (!Number.isFinite(pid)) return null;
        return { name, cwd: readlinkSync(`/proc/${pid}/cwd`), pid, started: '' };
    } catch {
        return null;
    }
}

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
    private readonly tagged = new Map<string, Socket>();
    private nextTag = 1;

    constructor(
        readonly name: string,
        command: string,
        args: readonly string[],
        readonly cwd: string,
    ) {
        // The agent is told its own name so it can find the socket an
        // attached interface forwards back to itself: that path is derived
        // from the name, and nothing else in the process knows it.
        this.agent = spawn(command, [...args], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, RHO_SESSION_NAME: name },
        });

        // pi's RPC mode is JSONL, so a line is the unit worth keeping and
        // replaying. Partial lines are held: half an event redraws nothing.
        let held = '';
        this.agent.stdout?.on('data', (chunk: Buffer) => {
            held += chunk.toString();
            const lines = held.split('\n');
            held = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                this.deliver(line);
            }
        });
        // The agent's stderr is not the protocol: pi writes stack traces there,
        // and pushing those bytes into a jsonl stream leaves clients walking
        // past half-lines that look like frames. It travels as an event of its
        // own, so a client can show it as what it is.
        let complaint = '';
        this.agent.stderr?.on('data', (chunk: Buffer) => {
            complaint += chunk.toString();
            const lines = complaint.split('\n');
            complaint = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                this.broadcast(Buffer.from(`${JSON.stringify({ type: 'rho_stderr', text: line })}\n`));
            }
        });
        this.agent.on('close', () => {
            this.ended = true;
            for (const client of this.clients) client.end();
            this.server?.close();
            try {
                rmSync(socketFor(this.name), { force: true });
                rmSync(pidFor(this.name), { force: true });
                rmSync(metaFor(this.name), { force: true });
            } catch {
                // already gone
            }
            // A broker with no agent is a process holding a machine's memory
            // for nothing: stopping a session left one behind every time,
            // reparented to init, and it took a stale socket with it. What to
            // do about it belongs to whoever built the broker, because in a
            // test that is this very process.
            this.onEnded?.();
        });
    }

    /** Called once the agent has gone, for an owner that should go with it. */
    onEnded: (() => void) | undefined;

    /**
     * A session nobody has attached to for a long time lets its agent go.
     *
     * An idle pi holds forty to a hundred and fifty megabytes, and eight of
     * them on a machine with less than a gigabyte put three quarters of a
     * gigabyte into swap: the next turn then waits for the agent to be read
     * back from disk, which is the stall it looks like. Stopping is not
     * forgetting -- the transcript stays and connecting again continues it --
     * so an idle session costing memory is a session that should not be
     * resident.
     */
    retireAfter(idleMs: number): void {
        if (idleMs <= 0) return;
        const check = setInterval(() => {
            if (this.clients.size > 0) {
                this.lastLeft = Date.now();
                return;
            }
            if (Date.now() - this.lastLeft < idleMs) return;
            clearInterval(check);
            this.stop();
        }, Math.min(idleMs, 60_000));
        check.unref?.();
    }

    private lastLeft = Date.now();

    /**
     * An answer goes to whoever asked; an event goes to everyone.
     *
     * The agent speaks to one stdout and the broker has several clients, all
     * numbering their commands from one. Broadcasting the answers meant a
     * client could resolve its own r1 with another client's r1: asking where
     * the session was returned somebody else's state, one request behind, for
     * as long as two clients were attached.
     *
     * So a command is tagged with the client it came from on the way in, and
     * the tag is taken off the answer on the way out.
     */
    private deliver(line: string): void {
        let parsed: { type?: string; id?: unknown } | null = null;
        try {
            parsed = JSON.parse(line) as { type?: string; id?: unknown };
        } catch {
            parsed = null;
        }
        const id = typeof parsed?.id === 'string' ? parsed.id : null;
        const tagged = parsed?.type === 'response' && id !== null ? TAG.exec(id) : null;
        if (tagged === null) {
            // An event: everyone watching wants it, and a late client wants it
            // replayed. Answers are nobody else's business and are not kept.
            const bytes = Buffer.from(`${line}\n`);
            if (parsed?.type !== 'response') this.remember(bytes);
            this.broadcast(bytes);
            return;
        }
        const owner = this.tagged.get(tagged[1] as string);
        if (owner === undefined) return; // the client that asked has gone
        owner.write(`${JSON.stringify({ ...parsed, id: tagged[2] })}\n`);
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
            const tag = `c${this.nextTag++}`;
            this.tagged.set(tag, client);
            // The buffer is history, and a client that cannot tell it from
            // live events answers the last question again: it is bracketed so
            // a viewer can draw it as what already happened.
            if (this.recent.length > 0) {
                client.write(`${JSON.stringify({ type: 'rho_replay_start' })}\n`);
                for (const line of this.recent) client.write(line);
                client.write(`${JSON.stringify({ type: 'rho_replay_end' })}\n`);
            }
            // Some questions are the broker's own, not the agent's: where the
            // session is, and what it is called. A client that has to ask the
            // agent for those gets an answer about a machine it cannot see.
            let asked = '';
            client.on('data', (chunk: Buffer) => {
                asked += chunk.toString();
                const lines = asked.split('\n');
                asked = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.trim() === '') continue;
                    let parsed: { type?: string; id?: string } | null = null;
                    try {
                        parsed = JSON.parse(line) as { type?: string; id?: string };
                    } catch {
                        parsed = null;
                    }
                    if (parsed !== null && typeof parsed.id === 'string' && parsed.type !== 'rho_info') {
                        // Tagged with the client, so the answer can find its
                        // way back to it rather than to everyone.
                        this.agent.stdin?.write(`${JSON.stringify({ ...parsed, id: `${tag}|${parsed.id}` })}\n`);
                        continue;
                    }
                    if (parsed?.type === 'rho_stop') {
                        // Asked through the socket, because the pid file is not
                        // always there: four sessions on dev-box had lost
                        // theirs and could not be stopped at all, while their
                        // sockets answered perfectly well.
                        client.write(
                            `${JSON.stringify({ type: 'response', id: parsed.id, command: 'rho_stop', success: true })}\n`,
                        );
                        setTimeout(() => this.stop(), 50).unref?.();
                        continue;
                    }
                    if (parsed?.type === 'rho_info') {
                        // The branch travels with the directory: the interface
                        // shows one, and a branch read on the laptop belongs to
                        // a checkout the session cannot see.
                        let branch: string | null = null;
                        try {
                            branch = execFileSync('git', ['-C', this.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
                                encoding: 'utf8',
                                stdio: ['ignore', 'pipe', 'ignore'],
                            }).trim();
                        } catch {
                            // not a work tree, or no git here
                        }
                        client.write(
                            `${JSON.stringify({
                                type: 'response',
                                id: parsed.id,
                                command: 'rho_info',
                                success: true,
                                data: { cwd: this.cwd, name: this.name, branch },
                            })}\n`,
                        );
                        continue;
                    }
                    this.agent.stdin?.write(`${line}\n`);
                }
            });
            const drop = () => {
                this.clients.delete(client);
                this.tagged.delete(tag);
            };
            client.on('close', drop);
            client.on('error', drop);
        });
        this.server.listen(path);
        writeFileSync(pidFor(this.name), `${process.pid}\n`);
        writeFileSync(
            metaFor(this.name),
            `${JSON.stringify({ name: this.name, cwd: this.cwd, pid: process.pid, started: new Date().toISOString() })}\n`,
        );
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
/** Ask a session to stop through its own socket, for when the pid file is gone. */
export function askToStop(name: string): Promise<boolean> {
    return new Promise((settle) => {
        const socket = connectSocket(socketFor(name));
        const give = (answer: boolean) => {
            socket.destroy();
            settle(answer);
        };
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({ type: 'rho_stop', id: 'stop' })}\n`);
            setTimeout(() => give(true), 300);
        });
        socket.on('error', () => give(false));
    });
}

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
        rmSync(metaFor(name), { force: true });
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

        // This dies with its connection, in every direction.
        //
        // Watching only the socket left one of these behind every time a
        // viewer closed: ssh went away, its end of the pipe closed, and the
        // relay carried on holding a client slot. Fifteen of them accumulated
        // in one afternoon, and each one is a process the machine is keeping
        // alive for nobody. The executor learnt this first; this is its twin.
        let finished = false;
        const done = () => {
            if (finished) return;
            finished = true;
            socket.destroy();
            settle();
        };

        socket.on('connect', () => {
            // `{ end: false }` because a viewer that stops sending is still
            // watching: the default ends the socket when stdin does, so piping
            // one command in and waiting for the answer disconnects before the
            // answer arrives.
            input.pipe(socket, { end: false });
            socket.pipe(output);
        });
        socket.on('close', done);
        input.on('end', done);
        input.on('close', done);
        output.on('error', done);
        for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.on(signal, done);
        socket.on('error', (error) => {
            if (finished) return;
            finished = true;
            fail(new Error(`no session called ${name}: ${error.message}`));
        });
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
