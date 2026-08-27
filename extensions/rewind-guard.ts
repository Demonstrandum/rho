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
// a directory the guard admits can still fail every turn, when the work tree
// holds a path this process cannot read. pi-rewind retries on the next turn and
// warns again, so the same warning arrives once per turn for the whole session.
// [rewind] on-failure = 'disable-session' (the default) reports the first
// failure and stops there: lib/checkpoint-breaker.ts makes later checkpoints
// fail immediately, and this file drops their repeated notifications.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureGlobalSetting } from './lib/settings-store';
import { config } from './lib/config';
import { installCheckpointFastFail } from './lib/checkpoint-breaker';

export type CheckpointMode = 'git' | 'always' | 'never';

/** what the guard knows about a directory, so the decision stays testable. */
export interface DirectoryFacts {
    readonly cwd: string;
    readonly home: string;
    readonly insideGitWorkTree: boolean;
}

/**
 * a home directory is excluded even when it is a git work tree: a dotfiles
 * repo turns every turn into a snapshot of everything under home.
 */
export function shouldCheckpoint(mode: CheckpointMode, facts: DirectoryFacts): boolean {
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    if (resolve(facts.cwd) === resolve(facts.home)) return false;
    return facts.insideGitWorkTree;
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

/** pi-rewind's own prefix on every failed-checkpoint notification. */
const FAILURE_PREFIX = 'Checkpoint failed:';

const TRIPPED_MESSAGE = 'checkpoint disabled for this session after a failure';

type NotifyLevel = 'info' | 'warning' | 'error';

interface NotifyUI {
    notify(message: string, level?: NotifyLevel): void;
}

/** marks a ui object whose notify this process has already wrapped. */
const WRAPPED = Symbol.for('rho.rewind-guard.wrapped');

/**
 * the first failure is reported once, with the cause kept. every later one is
 * dropped, because the breaker produced it and the reader has been told.
 */
export function failureAction(
    message: string,
    tripped: boolean,
): 'pass' | 'report-once' | 'drop' {
    if (!message.startsWith(FAILURE_PREFIX)) return 'pass';
    return tripped ? 'drop' : 'report-once';
}

function watchCheckpointFailures(pi: ExtensionAPI): void {
    let tripped = false;

    pi.on('session_start', async (_event, ctx) => {
        if (!ctx.hasUI) return;
        const ui = ctx.ui as NotifyUI & { [WRAPPED]?: true };
        if (ui[WRAPPED] === true) return;
        const notify = ui.notify.bind(ui);

        // an in-memory session has no file, so pi-rewind has no storage to
        // find and no checkpoint to fail; the wrapper still costs nothing.
        const sessionFile = ctx.sessionManager.getSessionFile();
        const storage = sessionFile === undefined ? undefined : { sessionFile, cwd: ctx.cwd };

        ui.notify = (message: string, level?: NotifyLevel): void => {
            const action = failureAction(message, tripped);
            if (action === 'drop') return;
            if (action === 'report-once') {
                tripped = true;
                if (storage) void installCheckpointFastFail(storage, () => tripped, TRIPPED_MESSAGE);
                notify(`${message}\n${TRIPPED_MESSAGE}. /rewind has no checkpoints here.`, level);
                return;
            }
            notify(message, level);
        };
        ui[WRAPPED] = true;
    });
}

export default function (pi: ExtensionAPI) {
    if (config.rewind.onFailure === 'disable-session') watchCheckpointFailures(pi);

    const cwd = process.cwd();
    const enabled = shouldCheckpoint(config.rewind.autoCheckpoint, {
        cwd,
        home: homedir(),
        insideGitWorkTree: insideGitWorkTree(cwd),
    });
    try {
        ensureGlobalSetting(['ayu', 'checkpoint', 'enabled'], enabled);
    } catch {
        // best effort: a settings write failure must never break startup.
    }
}
