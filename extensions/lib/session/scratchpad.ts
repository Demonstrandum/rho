// resolves and prunes the scratch directory.
//
// separated from the extension so the path arithmetic and the pruning rule are
// testable without a session.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import envPaths from 'env-paths';

export type ScratchLocation = 'project' | 'data-dir' | 'off';

const paths = envPaths('rho', { suffix: '' });

export interface ScratchIdentity {
    readonly cwd: string;
    /** undefined for an in-memory session; the directory is then shared */
    readonly sessionId: string | undefined;
}

/**
 * `project` puts the directory inside the working tree, under `.rho/scratch/`.
 * that is the default because a tool confined to the workspace can read it:
 * context-mode refuses a path outside the project root, so a scratch file in
 * the data directory is writable by bash and unreadable by the very tools that
 * exist to summarise it.
 *
 * `data-dir` is for a working directory that must stay untouched.
 */
export const scratchRoot = (location: ScratchLocation, cwd: string): string | null => {
    switch (location) {
        case 'off': return null;
        case 'project': return join(cwd, '.rho', 'scratch');
        case 'data-dir': return join(paths.data, 'scratch');
    }
};

export const scratchDir = (location: ScratchLocation, identity: ScratchIdentity): string | null => {
    const root = scratchRoot(location, identity.cwd);
    if (root === null) return null;
    // a session id keeps two concurrent sessions in one project apart. an
    // in-memory session has none and shares one directory, which is the same
    // choice state-store makes.
    return join(root, identity.sessionId ?? 'no-session');
};

/** directories under `root` whose mtime is older than `days`. */
export const staleDirs = (root: string, days: number, now = Date.now()): string[] => {
    if (!existsSync(root)) return [];
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const out: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(root, entry.name);
        try {
            if (statSync(path).mtimeMs < cutoff) out.push(path);
        } catch {
            // vanished between the listing and the stat; nothing to prune.
        }
    }
    return out;
};

export const prepare = (
    location: ScratchLocation,
    identity: ScratchIdentity,
    keepDays: number,
): string | null => {
    const dir = scratchDir(location, identity);
    if (dir === null) return null;
    const root = scratchRoot(location, identity.cwd);
    if (root !== null) {
        for (const stale of staleDirs(root, keepDays)) rmSync(stale, { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true });
    return dir;
};
