// marimo servers: the ones already running, and the ones this session starts.
//
// A server started with `--no-token` writes a file to
// `$XDG_STATE_HOME/marimo/servers/<host>_<port>.json` (`~/.local/state/...`
// by default) and removes it on a clean exit, so the registry is where a
// running editor is found without asking the person for a port. A file whose
// process is gone and whose address does not answer is a crash's leftover,
// and is deleted here the way marimo-pair's discover script deletes it.
//
// Servers this session starts are children of this process: headless, no
// token, on the first free port from the configured one. They die with the
// session unless the person asked to keep them. The child's output is kept in
// a ring, since a server that failed to start says why on stderr.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { healthy } from './client';
import { run, type Runner } from './marimo-cli';

export interface RegisteredServer {
    readonly id: string;
    readonly pid: number;
    readonly host: string;
    readonly port: number;
    readonly baseUrl: string;
    readonly version: string;
    readonly startedAt: string;
    /** the address that answered, null when none did. */
    readonly url: string | null;
    readonly alive: boolean;
}

export function registryDir(): string {
    const xdg = process.env.XDG_STATE_HOME;
    const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'state');
    return join(base, 'marimo', 'servers');
}

const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means it exists and is not ours; ESRCH means gone.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

const connectHost = (host: string): string => (host === '0.0.0.0' || host === '' ? '127.0.0.1' : host === '::' ? '::1' : host);

/** every server the registry knows, with the dead entries pruned. */
export async function discover(): Promise<RegisteredServer[]> {
    const dir = registryDir();
    if (!existsSync(dir)) return [];
    const found: RegisteredServer[] = [];
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const file = join(dir, name);
        let raw: Record<string, unknown>;
        try {
            raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        } catch {
            continue;
        }
        const pid = typeof raw.pid === 'number' ? raw.pid : -1;
        const host = typeof raw.host === 'string' ? raw.host : '127.0.0.1';
        const port = typeof raw.port === 'number' ? raw.port : 0;
        const baseUrl = typeof raw.base_url === 'string' ? raw.base_url : '';
        const h = connectHost(host);
        const candidate = `http://${h.includes(':') ? `[${h}]` : h}:${port}${baseUrl}`;
        const alive = pid > 0 && processAlive(pid);
        const answers = await healthy(candidate);
        if (!alive && !answers) {
            rmSync(file, { force: true });
            continue;
        }
        found.push({
            id: typeof raw.server_id === 'string' ? raw.server_id : `${host}:${port}`,
            pid,
            host,
            port,
            baseUrl,
            version: typeof raw.version === 'string' ? raw.version : '',
            startedAt: typeof raw.started_at === 'string' ? raw.started_at : '',
            url: answers ? candidate : null,
            alive,
        });
    }
    return found;
}

/** the uv executable on PATH, or null. */
function whichUv(): string | null {
    for (const dir of (process.env.PATH ?? '').split(':')) {
        if (dir === '') continue;
        const candidate = join(dir, 'uv');
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

export function freePort(from: number, tries = 50): Promise<number> {
    const attempt = (port: number, left: number): Promise<number> =>
        new Promise((resolve, reject) => {
            const probe = createServer();
            probe.unref();
            probe.once('error', () => {
                if (left <= 0) reject(new Error(`no free port from ${from} to ${port}`));
                else attempt(port + 1, left - 1).then(resolve, reject);
            });
            probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
        });
    return attempt(from, tries);
}

export interface StartOptions {
    readonly runner: Runner;
    readonly cwd: string;
    /**
     * what the server serves: a directory, and any notebook under it can be
     * opened by path; or one file, which `--sandbox` needs, since the
     * environment it builds is that file's.
     */
    readonly target: string;
    readonly port: number;
    readonly sandbox: boolean;
    readonly mcp: boolean;
    readonly extraArgs?: readonly string[];
}

export interface Started {
    readonly url: string;
    readonly port: number;
    readonly pid: number;
    readonly command: string;
    readonly target: string;
    readonly sandbox: boolean;
    readonly child: ChildProcess;
    /** last lines the server wrote, for a failure report. */
    readonly tail: () => string;
    readonly stop: () => Promise<void>;
}

const LOG_RING = 60;
const START_TIMEOUT_MS = 90_000;

/** start `marimo edit` headless and wait until it answers. */
export async function start(options: StartOptions): Promise<Started> {
    const port = await freePort(options.port);
    const args = ['edit', options.target, '--headless', '--no-token', '--port', String(port), '--skip-update-check'];
    if (options.sandbox) args.push('--sandbox');
    if (options.mcp) args.push('--mcp');
    args.push(...(options.extraArgs ?? []));
    const [command, ...prefix] = options.runner.argv;
    const argv = [...prefix, ...args];
    // marimo picks its package manager from the environment: `UV` set means
    // uv, which is also what created a .venv that has no pip in it. a venv
    // runner therefore names uv and its venv, so the kernel's installs land
    // where its imports look.
    const env: NodeJS.ProcessEnv = { ...process.env, MARIMO_SKIP_UPDATE_CHECK: '1' };
    if (options.runner.kind === 'venv') {
        const venv = dirname(dirname(command!));
        const uv = whichUv();
        if (uv !== null) {
            env.UV = uv;
            env.VIRTUAL_ENV = venv;
        }
    }
    const child = spawn(command!, argv, {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });
    const ring: string[] = [];
    const keep = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
            if (line.trim() === '') continue;
            ring.push(line);
            if (ring.length > LOG_RING) ring.shift();
        }
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let exited: number | null | 'running' = 'running';
    child.on('exit', (code) => (exited = code));
    child.on('error', (error) => ring.push(`spawn failed: ${error.message}`));

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (exited !== 'running') {
            throw new Error(`marimo exited with ${String(exited)} before answering:\n${ring.join('\n')}`);
        }
        if (await healthy(url, 800)) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    if (!(await healthy(url, 800))) {
        child.kill('SIGTERM');
        throw new Error(`marimo did not answer on ${url} within ${START_TIMEOUT_MS / 1000}s:\n${ring.join('\n')}`);
    }
    const stop = () =>
        new Promise<void>((resolve) => {
            if (exited !== 'running') return resolve();
            const force = setTimeout(() => child.kill('SIGKILL'), 4_000);
            child.once('exit', () => {
                clearTimeout(force);
                resolve();
            });
            child.kill('SIGTERM');
        });
    return {
        url,
        port,
        pid: child.pid ?? -1,
        command: [command, ...argv].join(' '),
        target: options.target,
        sandbox: options.sandbox,
        child,
        tail: () => ring.join('\n'),
        stop,
    };
}

/** the installed marimo's version, or null when the runner cannot say. */
export async function version(runner: Runner, cwd: string): Promise<string | null> {
    const result = await run(runner, ['--version'], cwd, { timeoutMs: 60_000 });
    const text = result.stdout.trim();
    return result.code === 0 && text !== '' ? text : null;
}
