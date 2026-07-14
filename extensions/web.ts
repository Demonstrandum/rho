// /web: start the pi-web UI (https://github.com/jmfederico/pi-web) without a
// second terminal. with no args it runs `pi-web install` then `pi-web doctor`,
// which register persistent per-user services and health-check them; the server
// then keeps running in the background as an OS service. any pi-web subcommand
// can be passed through, e.g. /web status, /web stop, /web logs.

import { spawn } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PACKAGE = '@jmfederico/pi-web';
const DEFAULT_URL = 'http://127.0.0.1:8504';
const SUBCOMMANDS = ['install', 'doctor', 'start', 'stop', 'restart', 'status', 'logs', 'version', 'uninstall'];

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

function findUrl(text: string): string | undefined {
    return text.match(/https?:\/\/\S+/)?.[0];
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand('web', {
        description: 'start the pi-web UI in the background (install + doctor), or run a pi-web subcommand',
        getArgumentCompletions: (prefix) => {
            const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix));
            return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
        },
        handler: async (args, ctx) => {
            const installed = (await run('pi-web', ['--version'])).code === 0;
            if (!installed) {
                const doInstall = await ctx.ui.confirm('pi-web', `pi-web is not installed. install ${PACKAGE} globally with Bun now?`);
                if (!doInstall) {
                    ctx.ui.notify(`run: bun install -g ${PACKAGE}`, 'info');
                    return;
                }
                ctx.ui.notify(`installing ${PACKAGE} ...`, 'info');
                const result = await run('bun', ['install', '-g', PACKAGE]);
                if (result.code !== 0) {
                    ctx.ui.notify(`install failed:\n${result.output.slice(-800)}`, 'error');
                    return;
                }
            }

            const arg = args.trim();
            const steps = arg === '' ? [['install'], ['doctor']] : [arg.split(/\s+/)];
            let url = DEFAULT_URL;
            for (const step of steps) {
                ctx.ui.notify(`pi-web ${step.join(' ')} ...`, 'info');
                const result = await run('pi-web', step);
                url = findUrl(result.output) ?? url;
                if (result.code !== 0) {
                    ctx.ui.notify(`pi-web ${step.join(' ')} failed:\n${result.output.slice(-800)}`, 'error');
                    return;
                }
            }

            if (arg === '' || arg === 'install' || arg === 'doctor' || arg === 'start' || arg === 'restart') {
                ctx.ui.notify(`pi-web ready: ${url}`, 'info');
            }
        },
    });
}
