// keep pi-rewind's per-turn checkpoint off where it cannot finish.
//
// the checkpoint engine snapshots the working directory into a shadow git repo
// on every turn, whatever the directory is. started from a home directory, the
// staging command is `git add -A -- .` with the work tree set to the whole of
// home, and it is killed at the engine's own two-minute timeout:
//
//   Warning: Checkpoint failed: Command timed out after 120000ms: git ...
//   --work-tree=/Users/samuel add -A -- .
//
// pi-rewind re-reads ~/.pi/agent/settings.json and <cwd>/.pi/settings.json in
// its own session_start handler, so a value written before the session starts
// is the value it uses. this extension writes ayu.checkpoint.enabled in the
// factory, which pi runs while loading extensions, before any session_start
// handler.
//
// [rewind] auto-checkpoint in rho.toml: 'git' (default) keeps checkpoints in a
// git work tree other than the home directory, 'always' and 'never' are fixed.
//
// whether staging can finish is decided before the first turn, not discovered
// during one. the guard runs `git status --porcelain=2` in the work tree at
// startup, which is the scan `git add -A` performs and the one that fails on a
// work tree holding an unreadable path, or holding pi-rewind's own shadow repo
// as an embedded repository with no work tree of its own.
//
// [rewind] on-failure = 'disable-session' (the default) states the reason in
// one line at the top of the session and then says nothing more: pi-rewind's
// per-turn `Checkpoint failed:` and `Checkpoint finalization failed:` warnings
// are dropped, and lib/checkpoint-breaker.ts makes any checkpoint the engine
// still attempts fail without spawning git. a warning under every reply is
// worse than no checkpoints, and the reader has already been told.
// 'keep-trying' restores pi-rewind's own behaviour, warning and all.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureGlobalSetting } from './lib/settings-store';
import { config } from './lib/config';
import { installCheckpointFastFail } from './lib/checkpoint-breaker';

export type CheckpointMode = 'git' | 'always' | 'never';

/** the result of the staging scan, or nothing when it was not run. */
export type StagingProbe = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** what the guard knows about a directory, so the decision stays testable. */
export interface DirectoryFacts {
    readonly cwd: string;
    readonly home: string;
    readonly insideGitWorkTree: boolean;
    /** true when the agent is running on another machine. */
    readonly elsewhere?: boolean;
    /** absent means the scan was skipped, which counts as passing. */
    readonly staging?: StagingProbe;
}

/** why checkpoints are off, in the order the guard establishes it. */
export type CheckpointBlock =
    | { readonly kind: 'elsewhere' }
    | { readonly kind: 'disabled' }
    | { readonly kind: 'home' }
    | { readonly kind: 'no-repo' }
    | { readonly kind: 'staging-fails'; readonly detail: string };

/**
 * a home directory is excluded even when it is a git work tree: a dotfiles
 * repo turns every turn into a snapshot of everything under home.
 */
export function checkpointBlock(
    mode: CheckpointMode,
    facts: DirectoryFacts,
): CheckpointBlock | undefined {
    // A session running on another machine edits files there, and a snapshot
    // of this machine's directory records none of it: it would be a checkpoint
    // of the wrong tree, taken every turn, that /rewind could not undo.
    if (facts.elsewhere === true) return { kind: 'elsewhere' };
    if (mode === 'always') return undefined;
    if (mode === 'never') return { kind: 'disabled' };
    if (resolve(facts.cwd) === resolve(facts.home)) return { kind: 'home' };
    if (!facts.insideGitWorkTree) return { kind: 'no-repo' };
    const staging = facts.staging;
    if (staging !== undefined && !staging.ok) {
        return { kind: 'staging-fails', detail: staging.detail };
    }
    return undefined;
}

export function shouldCheckpoint(mode: CheckpointMode, facts: DirectoryFacts): boolean {
    return checkpointBlock(mode, facts) === undefined;
}

/**
 * the one line the reader gets, at the top of the session. 'never' and
 * 'always' are the reader's own setting, so neither is announced.
 */
export function blockLine(block: CheckpointBlock, cwd: string): string | undefined {
    const off = '/rewind is off here';
    switch (block.kind) {
        case 'disabled':
            return undefined;
        case 'elsewhere':
            return `${off}: this session runs on another machine.`;
        case 'home':
            return `${off}: ${cwd} is your home directory, and a snapshot of it on every turn does not finish.`;
        case 'no-repo':
            return `${off}: ${cwd} is not a git repo.`;
        case 'staging-fails':
            return `${off}: git cannot stage ${cwd} (${block.detail}).`;
    }
}

function insideGitWorkTree(cwd: string): boolean {
    try {
        const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd,
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim() === 'true';
    } catch {
        // no git, no repo, or a directory that no longer exists.
        return false;
    }
}

/** how long the startup scan may take before the tree counts as too slow. */
const PROBE_TIMEOUT_MS = 5000;

/** the first `fatal:` git printed, or the first line it printed at all. */
export function probeDetail(stderr: string, timedOut: boolean): string {
    if (timedOut) return `no answer in ${PROBE_TIMEOUT_MS / 1000}s`;
    const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    const line = lines.find((candidate) => candidate.startsWith('fatal:')) ?? lines[0];
    if (line === undefined) return 'git exited non-zero';
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * run the scan `git add -A` runs. an embedded repository without a work tree,
 * an unreadable path, and a tree too large to walk all fail here, which is the
 * same set that fails the checkpoint.
 */
function probeStaging(cwd: string): StagingProbe {
    try {
        execFileSync('git', ['status', '--porcelain=2'], {
            cwd,
            encoding: 'utf8',
            timeout: PROBE_TIMEOUT_MS,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        return { ok: true };
    } catch (error) {
        const failure = error as { stderr?: string | Buffer; signal?: string | null };
        const stderr = failure.stderr === undefined ? '' : String(failure.stderr);
        return { ok: false, detail: probeDetail(stderr, failure.signal === 'SIGTERM') };
    }
}

/**
 * pi-rewind's own prefixes on a failed-checkpoint notification. the engine
 * stages twice per turn, once when the turn starts and once when it ends, and
 * each call site writes its own wording. both run RepoManager.stageAll, so one
 * cause produces both messages and the breaker stops both.
 */
const FAILURE_PREFIXES = ['Checkpoint failed:', 'Checkpoint finalization failed:'] as const;

const TRIPPED_MESSAGE = 'checkpoint disabled for this session after a failure';

/**
 * one startup line per process, not per ui object. the reader saw the previous
 * report twice because two objects each held their own first-failure flag.
 */
const ANNOUNCED = Symbol.for('rho.rewind-guard.announced');

function announceOnce(ui: NotifyUI, line: string): void {
    const scope = globalThis as { [ANNOUNCED]?: true };
    if (scope[ANNOUNCED] === true) return;
    scope[ANNOUNCED] = true;
    ui.notify(line, 'info');
}

type NotifyLevel = 'info' | 'warning' | 'error';

interface NotifyUI {
    notify(message: string, level?: NotifyLevel): void;
}

/** marks a ui object whose notify this process has already wrapped. */
const WRAPPED = Symbol.for('rho.rewind-guard.wrapped');

/**
 * a checkpoint failure never reaches the reader: the cause was stated at the
 * top of the session, or it is a cause the startup scan could not see, and
 * either way the message arrives under every reply until the session ends.
 */
export function failureAction(message: string): 'pass' | 'drop' {
    return FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix)) ? 'drop' : 'pass';
}

function watchCheckpointFailures(pi: ExtensionAPI, line: string | undefined): void {
    let tripped = false;

    pi.on('session_start', async (_event, ctx) => {
        if (!ctx.hasUI) return;
        const ui = ctx.ui as NotifyUI & { [WRAPPED]?: true };
        if (line !== undefined) announceOnce(ui, line);
        if (ui[WRAPPED] === true) return;
        const notify = ui.notify.bind(ui);

        // an in-memory session has no file, so pi-rewind has no storage to
        // find and no checkpoint to fail; the wrapper still costs nothing.
        const sessionFile = ctx.sessionManager.getSessionFile();
        const storage = sessionFile === undefined ? undefined : { sessionFile, cwd: ctx.cwd };

        ui.notify = (message: string, level?: NotifyLevel): void => {
            if (failureAction(message) === 'pass') {
                notify(message, level);
                return;
            }
            if (!tripped) {
                tripped = true;
                if (storage) void installCheckpointFastFail(storage, () => tripped, TRIPPED_MESSAGE);
            }
        };
        ui[WRAPPED] = true;
    });
}

export default function (pi: ExtensionAPI) {
    const cwd = process.cwd();
    // The remote client publishes this before any extension loads, so a
            // session drawn here but running elsewhere is known at this point.
    const elsewhere = (globalThis as { __rho_environment?: { alive?: boolean } }).__rho_environment?.alive === true;
    const mode = config.rewind.autoCheckpoint;
    const local = !elsewhere && mode === 'git';
    const inTree = local && insideGitWorkTree(cwd);
    const block = checkpointBlock(mode, {
        cwd,
        home: homedir(),
        insideGitWorkTree: inTree,
        elsewhere,
        // the scan costs a git process, so it runs only where its answer can
        // change the decision: a work tree that has passed every other check.
        staging: inTree && resolve(cwd) !== resolve(homedir()) ? probeStaging(cwd) : undefined,
    });
    const enabled = block === undefined;

    if (config.rewind.onFailure === 'disable-session') {
        watchCheckpointFailures(pi, block === undefined ? undefined : blockLine(block, cwd));
    }

    try {
        ensureGlobalSetting(['ayu', 'checkpoint', 'enabled'], enabled);
    } catch {
        // best effort: a settings write failure must never break startup.
    }
}
