#!/usr/bin/env bun
/**
 * The executable that runs on the far side.
 *
 * `bun build --compile` turns this into one static binary, which is what makes
 * a two-hour GPU node usable: no runtime to install, no package manager, no
 * root, nothing to clean up. Copy it, run it, and it dies with the connection.
 */

import { connect as connectSocket, createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Executor, serve } from './executor';

/**
 * Three shapes, chosen by argv, because reconnecting must not cost a deploy.
 *
 * Without arguments it serves one connection on stdio and dies with it, which
 * is the simple case and what the tests drive.
 *
 * `--socket <path> --idle <ms>` is the daemon: it holds the working directory,
 * the environment and the process table, serves whichever client is attached,
 * and exits after that long with nobody attached. A reconnect then costs one
 * ssh round trip instead of copying and starting an executor, which was taking
 * fourteen seconds.
 *
 * `--attach <path>` is the relay that a reconnecting client runs: stdio to the
 * daemon's socket, starting the daemon first if the socket is not there.
 */
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
};

const socketPath = flag('--socket');
const attachPath = flag('--attach');
/** Three hours: long enough to survive a break, short enough not to hold a rented node overnight. */
const idleMs = Number.parseInt(flag('--idle') ?? '10800000', 10);

if (attachPath !== undefined) {
    const relay = () => {
        const socket = connectSocket(attachPath);
        // The relay dies with its connection, in every direction.
        //
        // Watching only the socket left one of these alive on the far side
        // each time a session stopped: ssh went away, its end of the pipe
        // closed, and the relay carried on holding the daemon. The next
        // session then queued behind a client that no longer existed, which
        // looked like a slow reconnect and eventually like a hang.
        const done = () => {
            socket.destroy();
            process.exit(0);
        };
        socket.on('connect', () => {
            process.stdin.pipe(socket);
            socket.pipe(process.stdout);
        });
        socket.on('close', done);
        process.stdin.on('end', done);
        process.stdin.on('close', done);
        process.stdout.on('error', done);
        for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.on(signal, done);
        socket.on('error', (error) => {
            process.stderr.write(`executor: cannot reach the daemon: ${error.message}\n`);
            process.exit(1);
        });
    };

    if (existsSync(attachPath)) {
        relay();
    } else {
        // Started detached, so it survives this ssh channel closing, which is
        // the whole point of the daemon.
        const child = spawn(
            process.execPath,
            [process.argv[1] ?? '', '--socket', attachPath, '--idle', String(idleMs)],
            { detached: true, stdio: 'ignore' },
        );
        child.unref();
        const started = Date.now();
        const wait = setInterval(() => {
            if (existsSync(attachPath)) {
                clearInterval(wait);
                relay();
            } else if (Date.now() - started > 10_000) {
                clearInterval(wait);
                process.stderr.write('executor: the daemon did not start\n');
                process.exit(1);
            }
        }, 50);
    }
} else if (socketPath !== undefined) {
    mkdirSync(socketPath.replace(/\/[^/]*$/, ''), { recursive: true });
    rmSync(socketPath, { force: true });

    // One executor for the life of the daemon, so a reconnect finds the
    // directory, the environment and the processes where it left them.
    const executor = new Executor(() => {}, process.env.HOME ?? process.cwd());
    let idle: ReturnType<typeof setTimeout> | null = null;
    const goodbye = () => {
        executor.shutdown();
        rmSync(socketPath, { force: true });
        process.exit(0);
    };
    const startIdle = () => {
        if (idle !== null) clearTimeout(idle);
        idle = setTimeout(goodbye, idleMs);
    };

    // One client at a time, and the newest one wins.
    //
    // The state is a session's, so two clients sharing a working directory and
    // a process table would each see the other's moves. But a session whose
    // ssh channel dropped leaves an attachment that nothing closes, and
    // queueing behind it means the reconnect hangs forever rather than failing
    // -- which is exactly what a dropped connection looks like from here.
    let attached: import('node:net').Socket | null = null;

    const server = createServer((client) => {
        if (idle !== null) clearTimeout(idle);
        const previous = attached;
        attached = client;
        previous?.destroy();
        executor.attach(client, client);
        const leaving = () => {
            if (attached === client) {
                attached = null;
                startIdle();
            }
        };
        client.on('close', leaving);
        client.on('error', leaving);
    });
    server.listen(socketPath, () => startIdle());
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, goodbye);
} else {
    const executor = serve(process.stdin, process.stdout);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
        process.on(signal, () => {
            executor.shutdown();
            process.exit(0);
        });
    }
}

// A machine that takes the connection down whenever anything goes wrong is
// worse than no machine: the session loses the environment, the working
// directory and every process it was holding.
process.on('uncaughtException', (error) => {
    process.stderr.write(`executor: uncaught: ${(error as Error).message}\n`);
});
process.on('unhandledRejection', (reason) => {
    process.stderr.write(`executor: unhandled: ${String(reason)}\n`);
});
