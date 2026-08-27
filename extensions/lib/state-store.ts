// on-disk state for extensions whose state used to die with the process.
//
// three scopes, each a directory of json files under the rho data dir
// (~/Library/Application Support/rho/state on macOS,
// $XDG_DATA_HOME/rho/state on linux):
//
//   global   one file, shared by every session and every project
//   project  one file per working directory
//   session  one file per session uuid, so a resume finds its own state
//
// a session-scoped file outlives the session that wrote it, so opening a store
// also prunes files in that scope which have not been written to for
// PRUNE_AFTER_DAYS. writes go through a temp file and a rename, so a kill in
// the middle of one leaves the previous file intact rather than a half-written
// one.
//
// in a subdirectory so extension auto-discovery (top-level *.ts only) does not
// load it as an extension.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import envPaths from 'env-paths';

export type StateScope = 'global' | 'project' | 'session';

/**
 * what a stored file must contain to be usable. `parse` is a validator, not a
 * cast: a file written by an older version of the extension, hand-edited, or
 * truncated returns null and the store reports no state rather than handing
 * back a value of the wrong shape.
 */
export interface StateSpec<T> {
    /** file basename, e.g. 'stash' */
    readonly name: string;
    readonly scope: StateScope;
    readonly parse: (raw: unknown) => T | null;
}

/** what the scope of a store is resolved against. */
export interface StateIdentity {
    readonly cwd: string;
    /** undefined for an in-memory session, which gets no session-scoped file */
    readonly sessionId: string | undefined;
}

const PRUNE_AFTER_DAYS = 30;
const paths = envPaths('rho', { suffix: '' });

function stateDir(scope: StateScope): string {
    return join(paths.data, 'state', scope);
}

// a path is not a filename, and two projects can share a basename, so the
// basename is kept for legibility and the hash is what makes it unique.
function projectSlug(cwd: string): string {
    const digest = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
    const base = (cwd.split('/').filter((s) => s !== '').pop() ?? 'root').replace(/[^A-Za-z0-9._-]/g, '-');
    return `${base}-${digest}`;
}

function scopeSlug(scope: StateScope, identity: StateIdentity): string | null {
    switch (scope) {
        case 'global':
            return 'global';
        case 'project':
            return projectSlug(identity.cwd);
        case 'session':
            return identity.sessionId ?? null;
    }
}

/**
 * one json file holding one T. every method tolerates a missing directory, an
 * unreadable file, and an unparseable file; none of them throw.
 */
export class PersistedState<T> {
    private constructor(
        private readonly spec: StateSpec<T>,
        /** null when the scope has no file for this session (in-memory session) */
        private readonly path: string | null,
    ) {}

    static open<T>(spec: StateSpec<T>, identity: StateIdentity): PersistedState<T> {
        const slug = scopeSlug(spec.scope, identity);
        const dir = stateDir(spec.scope);
        const state = new PersistedState(spec, slug === null ? null : join(dir, `${slug}.${spec.name}.json`));
        if (spec.scope === 'session') prune(dir, spec.name);
        return state;
    }

    get file(): string | null {
        return this.path;
    }

    read(): T | null {
        if (this.path === null || !existsSync(this.path)) return null;
        try {
            return this.spec.parse(JSON.parse(readFileSync(this.path, 'utf8')) as unknown);
        } catch {
            return null;
        }
    }

    write(value: T): boolean {
        if (this.path === null) return false;
        const temp = `${this.path}.${process.pid}.tmp`;
        try {
            mkdirSync(stateDir(this.spec.scope), { recursive: true });
            writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
            renameSync(temp, this.path);
            return true;
        } catch {
            try {
                rmSync(temp, { force: true });
            } catch {
                // nothing left to do; the state is simply not persisted.
            }
            return false;
        }
    }

    clear(): void {
        if (this.path === null) return;
        try {
            rmSync(this.path, { force: true });
        } catch {
            // a stale file is harmless: parse rejects what it cannot use.
        }
    }
}

function prune(dir: string, name: string): void {
    const cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    let files: string[];
    try {
        files = readdirSync(dir);
    } catch {
        return;
    }
    for (const file of files) {
        if (!file.endsWith(`.${name}.json`)) continue;
        const full = join(dir, file);
        try {
            if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
        } catch {
            // raced with another process removing the same file.
        }
    }
}
