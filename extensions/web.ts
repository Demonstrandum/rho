// /web: run the pi-web UI (https://github.com/jmfederico/pi-web) as a background
// service and open it in the browser.
//
//   /web           install if needed, (re)start, health-check, open the browser
//   /web 8000      same, but serve on port 8000 (rewrites config, restarts)
//   /web stop      stop the background service
//   /web restart   restart and reopen
//   /web open      just open the current URL in the browser
//   /web status|logs|doctor|version|uninstall   pass through to the pi-web CLI
//
// pi-web registers persistent per-user services (LaunchAgents / systemd), so the
// server keeps running after the pi session exits. `/web` self-heals the known
// node-pty spawn-helper chmod issue that its own doctor reports.

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const PACKAGE = '@jmfederico/pi-web';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8504;

// pi-web CLI verbs that we forward verbatim. 'start'/'restart' additionally reopen
// the browser; the rest just report their output.
const PASSTHROUGH = ['stop', 'start', 'restart', 'status', 'logs', 'doctor', 'version', 'uninstall'] as const;
const REOPEN_AFTER = new Set<string>(['start', 'restart']);
const COMPLETIONS = [...PASSTHROUGH, 'open'];

interface PiWebConfig {
    host?: string;
    port?: number;
    allowedHosts?: string[];
    [key: string]: unknown;
}

type Command =
    | { kind: 'up'; port?: number }
    | { kind: 'open' }
    | { kind: 'passthrough'; verb: (typeof PASSTHROUGH)[number]; args: string[] }
    | { kind: 'error'; message: string };

interface RunResult {
    code: number;
    output: string;
}

function run(command: string, args: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { env: process.env });
        let output = '';
        child.stdout?.on('data', (chunk) => (output += chunk.toString()));
        child.stderr?.on('data', (chunk) => (output += chunk.toString()));
        child.on('error', (error) => resolve({ code: -1, output: `${output}${error}` }));
        child.on('close', (code) => resolve({ code: code ?? -1, output }));
    });
}

// mirrors pi-web's defaultPiWebConfigPath(): XDG_CONFIG_HOME or ~/.config.
function configPath(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg && xdg !== '' ? xdg : join(homedir(), '.config');
    return join(base, 'pi-web', 'config.json');
}

function readConfig(): PiWebConfig {
    const path = configPath();
    if (!existsSync(path)) {
        return {};
    }
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as PiWebConfig;
    } catch {
        return {};
    }
}

function writeConfig(config: PiWebConfig): void {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function urlFrom(config: PiWebConfig): string {
    // a wildcard bind is not browsable; point the browser at loopback instead.
    const host = !config.host || config.host === '0.0.0.0' || config.host === '::' ? DEFAULT_HOST : config.host;
    return `http://${host}:${config.port ?? DEFAULT_PORT}`;
}

// register the current session's cwd as a pi-web project so its sessions show up
// without adding it by hand. pi-web dedupes by path, so this is idempotent. the
// server may need a moment to accept connections after a (re)start, hence retry.
async function registerProject(baseUrl: string, path: string, attempts = 10): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = await fetch(`${baseUrl}/api/projects`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path }),
            });
            if (response.ok) {
                return true;
            }
        } catch {
            // server not accepting yet; fall through to the delay and retry.
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
}

function openBrowser(url: string): void {
    const [command, args] =
        process.platform === 'darwin'
            ? ['open', [url]]
            : process.platform === 'win32'
              ? ['cmd', ['/c', 'start', '', url]]
              : ['xdg-open', [url]];
    spawn(command as string, args as string[], { stdio: 'ignore', detached: true }).unref();
}

// pi-web doctor prints "chmod +x '<path>'" when the node-pty spawn-helper lacks
// the executable bit (a known upstream packaging bug). apply it automatically.
function fixSpawnHelper(doctorOutput: string): boolean {
    const match = doctorOutput.match(/chmod \+x '([^']+)'/);
    if (!match) {
        return false;
    }
    try {
        chmodSync(match[1], 0o755);
        return true;
    } catch {
        return false;
    }
}

function parse(arg: string): Command {
    if (arg === '') {
        return { kind: 'up' };
    }
    const parts = arg.split(/\s+/);
    const [head] = parts;
    if (parts.length === 1 && /^\d+$/.test(head)) {
        const port = Number(head);
        if (port < 1 || port > 65535) {
            return { kind: 'error', message: `invalid port: ${head}` };
        }
        return { kind: 'up', port };
    }
    if (head === 'open') {
        return { kind: 'open' };
    }
    const verb = PASSTHROUGH.find((name) => name === head);
    if (verb) {
        return { kind: 'passthrough', verb, args: parts };
    }
    return {
        kind: 'error',
        message: `unknown: ${arg}\nusage: /web [PORT] | stop | restart | status | logs | doctor | open`,
    };
}

async function ensureInstalled(ctx: ExtensionContext): Promise<boolean> {
    if ((await run('pi-web', ['--version'])).code === 0) {
        return true;
    }
    const doInstall = await ctx.ui.confirm('pi-web', `pi-web is not installed. install ${PACKAGE} globally with Bun now?`);
    if (!doInstall) {
        ctx.ui.notify(`run: bun install -g ${PACKAGE}`, 'info');
        return false;
    }
    ctx.ui.notify(`installing ${PACKAGE} ...`, 'info');
    const result = await run('bun', ['install', '-g', PACKAGE]);
    if (result.code !== 0) {
        ctx.ui.notify(`install failed:\n${result.output.slice(-800)}`, 'error');
        return false;
    }
    return true;
}

async function bringUp(ctx: ExtensionContext, port: number | undefined): Promise<void> {
    if (port !== undefined) {
        writeConfig({ ...readConfig(), port });
    }

    ctx.ui.notify('pi-web install ...', 'info');
    const install = await run('pi-web', ['install']);
    if (install.code !== 0) {
        ctx.ui.notify(`pi-web install failed:\n${install.output.slice(-800)}`, 'error');
        return;
    }

    ctx.ui.notify('pi-web doctor ...', 'info');
    let doctor = await run('pi-web', ['doctor']);
    if (doctor.code !== 0 && fixSpawnHelper(doctor.output)) {
        doctor = await run('pi-web', ['doctor']);
    }
    if (doctor.code !== 0) {
        ctx.ui.notify(`pi-web doctor failed:\n${doctor.output.slice(-800)}`, 'error');
        return;
    }

    // install only writes config.json when absent, so a port change needs a
    // restart for the running server to pick it up.
    if (port !== undefined) {
        ctx.ui.notify('pi-web restart ...', 'info');
        const restart = await run('pi-web', ['restart']);
        if (restart.code !== 0) {
            ctx.ui.notify(`pi-web restart failed:\n${restart.output.slice(-800)}`, 'error');
            return;
        }
    }

    const url = urlFrom(readConfig());
    const cwd = ctx.sessionManager.getCwd();
    const registered = await registerProject(url, cwd);
    openBrowser(url);
    ctx.ui.notify(registered ? `pi-web ready: ${url} (project: ${cwd})` : `pi-web ready: ${url}`, 'info');
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand('web', {
        description: 'run the pi-web UI in the background and open it; /web PORT sets the port, /web stop shuts it down',
        getArgumentCompletions: (prefix) => {
            const matches = COMPLETIONS.filter((name) => name.startsWith(prefix));
            return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
        },
        handler: async (args, ctx) => {
            const command = parse(args.trim());
            if (command.kind === 'error') {
                ctx.ui.notify(command.message, 'error');
                return;
            }
            if (!(await ensureInstalled(ctx))) {
                return;
            }

            if (command.kind === 'open') {
                const url = urlFrom(readConfig());
                openBrowser(url);
                ctx.ui.notify(`opening ${url}`, 'info');
                return;
            }

            if (command.kind === 'up') {
                await bringUp(ctx, command.port);
                return;
            }

            ctx.ui.notify(`pi-web ${command.args.join(' ')} ...`, 'info');
            const result = await run('pi-web', command.args);
            if (result.code !== 0) {
                ctx.ui.notify(`pi-web ${command.args.join(' ')} failed:\n${result.output.slice(-800)}`, 'error');
                return;
            }
            if (REOPEN_AFTER.has(command.verb)) {
                const url = urlFrom(readConfig());
                openBrowser(url);
                ctx.ui.notify(`pi-web ready: ${url}`, 'info');
                return;
            }
            ctx.ui.notify(result.output.trim() ? result.output.trim().slice(-800) : `pi-web ${command.verb} done`, 'info');
        },
    });
}
