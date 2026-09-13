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
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attach, Broker, existing, named, stop } from './broker';

const [verb, name, ...rest] = process.argv.slice(2);

const die = (message: string): never => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
};

if (verb === 'list') {
    const sessions = named();
    let alive = 0;
    for (const session of sessions) {
        if (await existing(session)) {
            alive += 1;
            process.stdout.write(`${session}\trunning\n`);
            continue;
        }
        // A socket with nothing behind it is litter from a broker that was
        // killed: reporting it as a session means the next person tries to
        // attach to something that cannot answer.
        stop(session);
    }
    if (alive === 0) process.stdout.write('no sessions\n');
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

/**
 * Credentials for the agent, read from stdin rather than taken from argv.
 *
 * The host has no API key of its own, and it should not acquire one: a key in
 * a file on a machine is a key that outlives the session and gets backed up.
 * The laptop sends it down the ssh channel at start, it lands in the session
 * process's environment, and it dies with the session. argv is not an option
 * because `ps` shows it to every user on the box.
 */
interface Lent {
    readonly env: Record<string, string>;
    /** the contents of the laptop's auth.json, for OAuth logins and stored keys. */
    readonly auth: string | null;
}

const readFromStdin = async (): Promise<Lent> => {
    if (process.stdin.isTTY) return { env: {}, auth: null };
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString().trim();
    if (text === '') return { env: {}, auth: null };
    try {
        const parsed = JSON.parse(text) as { env?: unknown; auth?: unknown };
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries((parsed.env ?? {}) as Record<string, unknown>)) {
            if (typeof value === 'string') env[key] = value;
        }
        return { env, auth: typeof parsed.auth === 'string' ? parsed.auth : null };
    } catch {
        return { env: {}, auth: null };
    }
};

/**
 * A config directory of this session's own, holding the laptop's credentials.
 *
 * An API key can travel as an environment variable; an OAuth login cannot,
 * because pi reads it from auth.json. Writing that into the host's own
 * ~/.pi/agent would leave the person's tokens on a machine they did not put
 * them on, and they would outlive the session and end up in backups.
 *
 * So the session gets its own directory, mode 0700, with everything else in
 * the real config directory symlinked in so settings, packages and extensions
 * still resolve. PI_CODING_AGENT_DIR points pi at it. It is removed when the
 * session ends.
 */
const credentialDir = (name: string): string =>
    join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `rho-session-${name}`);

const lendCredentials = (auth: string, name: string): string => {
    const real = join(process.env.HOME ?? '/tmp', '.pi', 'agent');
    const dir = credentialDir(name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    try {
        for (const entry of readdirSync(real)) {
            if (entry === 'auth.json') continue;
            try {
                symlinkSync(join(real, entry), join(dir, entry));
            } catch {
                // an entry that cannot be linked is one pi will do without
            }
        }
    } catch {
        // no config directory on the far side: the credentials alone will do
    }

    writeFileSync(join(dir, 'auth.json'), auth, { mode: 0o600 });
    return dir;
};

/**
 * Credentials again, for a session that is already running.
 *
 * An OAuth token lasts hours and its refresh token is single use: the laptop
 * refreshing its own login invalidates the copy the far side is holding, and
 * the next turn there comes back empty with the refusal buried in the message.
 * pi rereads auth.json when it changes, so handing it a newer one is enough --
 * no restart, and the session keeps its history.
 */
if (verb === 'relend') {
    const lent = await readFromStdin();
    if (lent.auth === null) die('nothing to lend');
    const dir = credentialDir(name);
    if (!existsSync(dir)) die(`${name} has no credentials of its own to replace`);
    writeFileSync(join(dir, 'auth.json'), lent.auth ?? '{}', { mode: 0o600 });
    process.stdout.write(`${name} has fresh credentials\n`);
    process.exit(0);
}

if (verb === 'serve') {
    if (await existing(name)) die(`${name} is already running`);

    const cwd = rest[0] !== undefined && !rest[0].startsWith('-') ? rest[0] : process.env.HOME ?? '/';
    const piArgs = rest.includes('--') ? rest.slice(rest.indexOf('--') + 1) : [];

    // Detach unless asked not to: `ssh host rho-session serve` returns as soon
    // as the session is up, and the session stays.
    if (process.env.RHO_SESSION_FOREGROUND !== '1') {
        const lent = await readFromStdin();
        const credentials = lent.auth === null ? {} : { PI_CODING_AGENT_DIR: lendCredentials(lent.auth, name) };
        const child = spawn(process.execPath, [import.meta.filename, 'serve', name, ...rest], {
            cwd,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, ...lent.env, ...credentials, RHO_SESSION_FOREGROUND: '1' },
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
