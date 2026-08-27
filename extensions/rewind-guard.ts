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

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureGlobalSetting } from './lib/settings-store';
import { config } from './lib/config';

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

export default function (_pi: ExtensionAPI) {
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
