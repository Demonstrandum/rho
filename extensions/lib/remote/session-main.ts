#!/usr/bin/env bun
/**
 * The command that runs on the always-on host.
 *
 *   rho-session serve <name> [cwd] [-- pi args...]   own a session
 *   rho-session attach <name>                        connect stdio to one
 *   rho-session list                                 what is running
 *   rho-session stop <name>
 *
 * `serve` detaches: it is started over ssh by a laptop that then goes away, so
 * a session tied to that ssh channel would die with it, which is the whole
 * thing this exists to prevent.
 */

import { spawn } from 'node:child_process';
import { attach, Broker, existing, named, stop } from './broker';

const [verb, name, ...rest] = process.argv.slice(2);

const die = (message: string): never => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
};

if (verb === 'list') {
    const sessions = named();
    for (const session of sessions) {
        process.stdout.write(`${session}\t${(await existing(session)) ? 'running' : 'stale'}\n`);
    }
    if (sessions.length === 0) process.stdout.write('no sessions\n');
    process.exit(0);
}

if (name === undefined) die(`usage: rho-session <serve|attach|list|stop> <name>`);

if (verb === 'attach') {
    if (!(await existing(name))) die(`no session called ${name}`);
    await attach(name, process.stdin, process.stdout);
    process.exit(0);
}

if (verb === 'stop') {
    // Signals the broker, which ends the agent, drops every attached client
    // and removes the socket: its own close path, rather than a second way of
    // tearing a session down that could disagree with the first.
    process.stdout.write(stop(name) ? `stopped ${name}\n` : `no session called ${name}\n`);
    process.exit(0);
}

if (verb === 'serve') {
    if (await existing(name)) die(`${name} is already running`);

    const cwd = rest[0] !== undefined && !rest[0].startsWith('-') ? rest[0] : process.env.HOME ?? '/';
    const piArgs = rest.includes('--') ? rest.slice(rest.indexOf('--') + 1) : [];

    // Detach unless asked not to: `ssh host rho-session serve` returns as soon
    // as the session is up, and the session stays.
    if (process.env.RHO_SESSION_FOREGROUND !== '1') {
        const child = spawn(process.execPath, [import.meta.filename, 'serve', name, ...rest], {
            cwd,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, RHO_SESSION_FOREGROUND: '1' },
        });
        child.unref();
        // Wait for the socket rather than claiming success: a session that
        // failed to start should say so while the laptop is still listening.
        for (let waited = 0; waited < 10_000; waited += 200) {
            if (await existing(name)) {
                process.stdout.write(`${name} is running in ${cwd}\n`);
                process.exit(0);
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        die(`${name} did not start`);
    }

    const broker = new Broker(name, 'pi', ['--mode', 'rpc', '--name', name, ...piArgs], cwd);
    broker.listen();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => broker.stop());
    // Nothing else to do: the broker owns the process and the socket.
    await new Promise(() => {});
}

die(`unknown command: ${verb}`);
