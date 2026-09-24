// /update: bring pi and rho up to date, then reload the session.
//
//   /update        pi, then the packages, then reload
//   /update pi     pi only
//   /update rho    rho only
//
// Three things can be behind, and only one of them is pi's job. `pi update`
// updates pi itself and reinstalls every package, which covers an rho installed
// from git under the agent directory. An rho installed as a local path is a
// working checkout that pi never touches, so the commits arrive by a
// fast-forward here. The third is the launcher's shebang: a pi self-update
// rewrites it to node, and rho's postinstall only runs for a package install,
// so the repair is run again from lib/bun-launcher.ts.
//
// The checkout is moved by `merge --ff-only` and by nothing else. A divergence,
// a conflict with uncommitted work, and a missing upstream are all reported
// rather than resolved: every way out of them either rewrites history or
// discards work in the tree.
//
// pi's own new version belongs to the next process, since this one is already
// running the old bundle. Extensions and resources are what /reload picks up,
// so a self-update ends with a note that the rest waits for a restart.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { bunBinary, describe, findLauncher, repairLaunchers } from './lib/core/bun-launcher';
import { completeLastWord } from './lib/tui/complete-words';
import { rhoRoot } from './lib/core/rho-root';
import { withSpinner } from './lib/chrome/widget-spinner';

const ROOT = rhoRoot(fileURLToPath(import.meta.url));

// a network install of pi plus every package, on a slow link.
const TIMEOUT_MS = 15 * 60 * 1000;

/** files whose change in an incoming range means the checkout needs installing. */
const MANIFESTS = ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json'];

export type Target = 'pi' | 'rho';

const TARGETS: readonly { readonly name: Target; readonly description: string }[] = [
    { name: 'pi', description: 'pi itself, and its launcher shebang' },
    { name: 'rho', description: 'the rho package, or its checkout' },
];

/** One step of the update, as it is reported. */
export interface Step {
    readonly title: string;
    /** true when something on disk moved, which is what makes a reload worth doing. */
    readonly changed: boolean;
    readonly detail: string;
    readonly failed?: boolean;
}

interface Ran {
    readonly code: number;
    readonly output: string;
}

function run(command: string, args: readonly string[], cwd?: string): Promise<Ran> {
    return new Promise((resolve) => {
        const child = spawn(command, [...args], {
            cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
        child.stdout?.on('data', (chunk) => (output += String(chunk)));
        child.stderr?.on('data', (chunk) => (output += String(chunk)));
        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ code: -1, output: `${output}${error}` });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, output });
        });
    });
}

const git = (args: readonly string[]): Promise<Ran> => run('git', ['-C', ROOT, ...args]);

const trimmed = (ran: Ran): string => ran.output.trim();

/** the last line with anything on it: a git failure says what went wrong there. */
const lastLine = (ran: Ran): string => {
    const lines = trimmed(ran).split('\n').filter((line) => line.trim() !== '');
    return lines[lines.length - 1] ?? '';
};

/**
 * pi run as a child, by path rather than through PATH.
 *
 * `bun run` prepends node_modules/.bin, and rho carries pi as a devDependency,
 * so a PATH lookup from inside a checkout answers with rho's own copy instead
 * of the install being updated.
 */
async function pi(args: readonly string[]): Promise<Ran> {
    const launcher = findLauncher();
    const bun = bunBinary();
    if (launcher === null) return { code: -1, output: "pi's launcher was not found" };
    return bun === null ? run(launcher, args) : run(bun, [launcher, ...args]);
}

async function piVersion(): Promise<string | null> {
    const ran = await pi(['--version']);
    return ran.code === 0 ? trimmed(ran) : null;
}

/** whether ROOT is a git work tree, which is what a local-path install is. */
async function isCheckout(): Promise<boolean> {
    const ran = await git(['rev-parse', '--is-inside-work-tree']);
    return ran.code === 0 && trimmed(ran) === 'true';
}

async function installDependencies(range: string): Promise<string> {
    const touched = await git(['diff', '--name-only', range]);
    const names = trimmed(touched).split('\n');
    if (!MANIFESTS.some((manifest) => names.includes(manifest))) return '';
    const bun = bunBinary();
    if (bun === null) return '; bun is not on PATH, so dependencies were left as they were';
    const installed = await run(bun, ['install'], ROOT);
    return installed.code === 0 ? '; dependencies installed' : `; bun install failed: ${lastLine(installed)}`;
}

/**
 * Move the checkout to its upstream, when that is a fast-forward.
 *
 * Uncommitted work is not in the way of a fast-forward unless the incoming
 * commits touch the same files, and git refuses in exactly that case, so the
 * merge is attempted and git's refusal is what gets reported.
 */
async function pullCheckout(): Promise<Step> {
    const title = `checkout ${ROOT}`;
    const fetched = await git(['fetch', '--quiet']);
    if (fetched.code !== 0) return { title, changed: false, failed: true, detail: `fetch failed: ${lastLine(fetched)}` };

    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstream.code !== 0) {
        const branch = trimmed(await git(['branch', '--show-current']));
        return { title, changed: false, detail: `${branch || 'HEAD'} tracks no branch, so there was nothing to pull` };
    }
    const tracking = trimmed(upstream);

    const counts = await git(['rev-list', '--count', '--left-right', `${tracking}...HEAD`]);
    const [behindText, aheadText] = trimmed(counts).split(/\s+/);
    const behind = Number(behindText ?? '0');
    const ahead = Number(aheadText ?? '0');
    if (behind === 0) return { title, changed: false, detail: `already at ${tracking}` };
    if (ahead > 0) {
        return {
            title,
            changed: false,
            detail: `${behind} behind and ${ahead} ahead of ${tracking}; merge or rebase it yourself`,
        };
    }

    const before = trimmed(await git(['rev-parse', 'HEAD']));
    const merged = await git(['merge', '--ff-only', tracking]);
    if (merged.code !== 0) return { title, changed: false, failed: true, detail: lastLine(merged) };
    const after = trimmed(await git(['rev-parse', 'HEAD']));
    const note = await installDependencies(`${before}..${after}`);
    return { title, changed: true, detail: `${behind} commit${behind === 1 ? '' : 's'} to ${after.slice(0, 7)}${note}` };
}

/** `pi update`, with the flags that name the wanted targets. */
async function updatePackages(targets: ReadonlySet<Target>): Promise<Step> {
    const flag = targets.has('pi') ? (targets.has('rho') ? '--all' : '--self') : '--extensions';
    const title = `pi update ${flag}`;
    const before = targets.has('pi') ? await piVersion() : null;
    const ran = await pi(['update', flag]);
    if (ran.code !== 0) return { title, changed: false, failed: true, detail: lastLine(ran) || 'update failed' };
    const after = targets.has('pi') ? await piVersion() : null;
    if (before !== null && after !== null && before !== after) {
        return { title, changed: true, detail: `pi ${before} -> ${after}, which the next start runs` };
    }
    return { title, changed: false, detail: lastLine(ran) || 'nothing to do' };
}

/** the shebang a pi self-update rewrites back to node. */
function repairShebang(): Step {
    const repairs = repairLaunchers();
    const patched = repairs.some((repair) => repair.kind === 'patched');
    const broken = repairs.filter((repair) => repair.kind !== 'patched' && repair.kind !== 'already-bun');
    if (broken.length > 0) {
        return { title: 'launcher', changed: patched, failed: true, detail: broken.map(describe).join('; ') };
    }
    return { title: 'launcher', changed: patched, detail: patched ? 'shebang put back to bun' : 'already runs under bun' };
}

export function parseTargets(args: string): ReadonlySet<Target> | { readonly error: string } {
    const words = args.trim().split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) return new Set<Target>(['pi', 'rho']);
    const wanted = new Set<Target>();
    for (const word of words) {
        const target = TARGETS.find((candidate) => candidate.name === word.toLowerCase());
        if (target === undefined) return { error: `no such target: ${word}` };
        wanted.add(target.name);
    }
    return wanted;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand('update', {
        description: 'update pi and rho, then reload this session',
        getArgumentCompletions: (text) =>
            completeLastWord(
                text,
                TARGETS.map((target) => ({ value: target.name, description: target.description })),
            ),
        handler: async (args: string, ctx: ExtensionCommandContext) => {
            const wanted = parseTargets(args);
            if ('error' in wanted) {
                ctx.ui.notify(`${wanted.error}. usage: /update [pi] [rho]`, 'error');
                return;
            }

            const steps: Step[] = [];
            await withSpinner(ctx, 'rho-update', 'updating', async () => {
                if (wanted.has('rho') && (await isCheckout())) steps.push(await pullCheckout());
                steps.push(await updatePackages(wanted));
                if (wanted.has('pi')) steps.push(repairShebang());
            });

            const report = steps.map((step) => `${step.title}: ${step.detail}`).join('\n');
            const failed = steps.some((step) => step.failed === true);
            ctx.ui.notify(report, failed ? 'warning' : 'info');
            if (!steps.some((step) => step.changed)) return;
            await ctx.reload();
        },
    });
}
