// the files where the tools are acting, as a small set of operations.
//
// the write guard and the undo journal both have to answer questions about a
// path (does it exist, how large is it, what does it hash to) and act on it
// (copy it aside, move it back, put it in the trash). when an environment is
// attached those questions are about a file on another machine, and reading it
// into this process is the wrong way to ask: `capture` caps what one command
// may say at 64 KiB, so a backup taken that way would be silently truncated at
// about 48 KiB of source file.
//
// so a backup never crosses the wire. it is a copy made where the file is, in
// a directory on that machine, and undo copies it back there. the only things
// that travel are a stat line and a hash.
//
// two implementations of one interface: this machine through node:fs, and the
// current environment through shell commands over its connection. an addressed
// path naming a third machine has no store here, and the caller is expected to
// leave such a path alone rather than guess (see `storeFor`).

import { createHash } from 'node:crypto';
import { cp, mkdir, rename, rm, stat as fsStat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import envPaths from 'env-paths';

/** what a path is, where the tools act. */
export type Stat =
    | { readonly kind: 'absent' }
    | { readonly kind: 'file'; readonly bytes: number }
    | { readonly kind: 'directory' };

/** what a trash attempt did. `at` is the resting place when the tool named it. */
export type Trashed =
    | { readonly kind: 'trashed'; readonly at: string | null }
    | { readonly kind: 'failed'; readonly message: string };

/**
 * one machine's files. every method takes an absolute path on that machine.
 *
 * nothing here throws for an absent path: `stat` reports it and `digest`
 * answers null, because both are asked about paths that may not exist.
 */
export interface FileStore {
    /** 'local', or the name of the attached environment. */
    readonly machine: string;
    stat(path: string): Promise<Stat>;
    /** sha256 of the file's bytes, or null when it is absent or a directory. */
    digest(path: string): Promise<string | null>;
    /** copy a file or a whole directory, creating the parent of `to`. */
    copy(from: string, to: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
    /** delete a file or directory outright; an absent path is not an error. */
    delete(path: string): Promise<void>;
    trash(path: string): Promise<Trashed>;
    /**
     * the directory backups are kept in, on that machine. asked rather than
     * computed, because the home directory of the far side is not this one.
     */
    backupRoot(session: string): Promise<string>;
}

/** a path as one shell word, with nothing in it read by the shell. */
export function quote(path: string): string {
    return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** what one short command said, wherever it ran. */
export interface Said {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

export type Run = (command: string, timeoutMs?: number) => Promise<Said>;

/**
 * the trash command on that machine, tried in order.
 *
 * macOS 15 ships /usr/bin/trash, which moves an item to the user's trash with
 * its Put Back record intact; `-v` prints where it landed, which is what makes
 * an undo of a directory possible. on linux, gio and trash-put do the
 * freedesktop equivalent. nothing falls back to a plain delete: a remove that
 * silently stops being recoverable is the behaviour this whole file exists to
 * remove.
 */
const TRASH_COMMANDS: readonly { readonly probe: string; readonly line: (path: string) => string }[] = [
    { probe: 'trash', line: (path) => `trash -v ${quote(path)}` },
    { probe: 'gio', line: (path) => `gio trash ${quote(path)}` },
    { probe: 'trash-put', line: (path) => `trash-put ${quote(path)}` },
];

export const NO_TRASH_COMMAND =
    'no trash command on this machine: install one (macOS 15 has /usr/bin/trash, linux has gio or trash-cli) or set [files] remove-to = "delete" in rho.toml';

/** the destination /usr/bin/trash reports, out of `# Moved "src" to "dst"`. */
export function trashedAt(output: string): string | null {
    const found = /to "([^"]+)"/.exec(output);
    return found === null ? null : found[1]!;
}

/** trash through whichever command the machine has, using only `run`. */
export async function trashThrough(run: Run, path: string): Promise<Trashed> {
    for (const candidate of TRASH_COMMANDS) {
        const found = await run(`command -v ${candidate.probe}`);
        if (found.code !== 0) continue;
        const said = await run(candidate.line(path));
        if (said.code !== 0) {
            const why = said.stderr.trim() === '' ? said.stdout.trim() : said.stderr.trim();
            return { kind: 'failed', message: why === '' ? `${candidate.probe} refused it` : why };
        }
        return { kind: 'trashed', at: trashedAt(said.stdout) };
    }
    return { kind: 'failed', message: NO_TRASH_COMMAND };
}

/** the stat line the remote store asks for, and what it means. */
export function parseStatLine(line: string): Stat {
    const text = line.trim();
    if (text === 'absent') return { kind: 'absent' };
    if (text === 'directory') return { kind: 'directory' };
    const bytes = Number.parseInt(text, 10);
    return Number.isFinite(bytes) ? { kind: 'file', bytes } : { kind: 'absent' };
}

/** the first field of `shasum`/`sha256sum` output, which is the hash. */
export function parseDigestLine(line: string): string | null {
    const found = /^([0-9a-f]{64})\b/.exec(line.trim());
    return found === null ? null : found[1]!;
}

const paths = envPaths('rho', { suffix: '' });

/** where this machine keeps the copies, one directory per session. */
export const LOCAL_BACKUPS = join(paths.data, 'undo');

/** this machine, through node's own filesystem calls. */
export function localStore(): FileStore {
    const run: Run = (command, timeoutMs) =>
        new Promise((settle) => {
            execFile('/bin/sh', ['-c', command], { timeout: timeoutMs ?? 20_000 }, (error, stdout, stderr) => {
                const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
                settle({ code, stdout, stderr });
            });
        });
    return {
        machine: 'local',
        async stat(path) {
            try {
                const found = await fsStat(path);
                return found.isDirectory() ? { kind: 'directory' } : { kind: 'file', bytes: found.size };
            } catch {
                return { kind: 'absent' };
            }
        },
        async digest(path) {
            try {
                return createHash('sha256').update(await readFile(path)).digest('hex');
            } catch {
                return null;
            }
        },
        async copy(from, to) {
            await mkdir(dirname(to), { recursive: true });
            await cp(from, to, { recursive: true });
        },
        async move(from, to) {
            await mkdir(dirname(to), { recursive: true });
            await rename(from, to);
        },
        async delete(path) {
            await rm(path, { recursive: true, force: true });
        },
        trash(path) {
            return trashThrough(run, path);
        },
        backupRoot(session) {
            return Promise.resolve(join(LOCAL_BACKUPS, session));
        },
    };
}

/**
 * the current environment, through one command per operation.
 *
 * every command is portable sh: the far side is a machine somebody rented an
 * hour ago, and it has coreutils and nothing chosen.
 */
export function remoteStore(machine: string, run: Run): FileStore {
    let home: string | null = null;
    return {
        machine,
        async stat(path) {
            const p = quote(path);
            const said = await run(
                `if [ -d ${p} ]; then echo directory; elif [ -e ${p} ]; then wc -c < ${p} | tr -d ' '; else echo absent; fi`,
            );
            return said.code === 0 ? parseStatLine(said.stdout) : { kind: 'absent' };
        },
        async digest(path) {
            const p = quote(path);
            const said = await run(`sha256sum ${p} 2>/dev/null || shasum -a 256 ${p}`);
            return said.code === 0 ? parseDigestLine(said.stdout) : null;
        },
        async copy(from, to) {
            const made = await run(`mkdir -p ${quote(dirname(to))} && cp -a ${quote(from)} ${quote(to)}`);
            if (made.code !== 0) throw new Error(made.stderr.trim() || `could not copy ${from} on ${machine}`);
        },
        async move(from, to) {
            const made = await run(`mkdir -p ${quote(dirname(to))} && mv ${quote(from)} ${quote(to)}`);
            if (made.code !== 0) throw new Error(made.stderr.trim() || `could not move ${from} on ${machine}`);
        },
        async delete(path) {
            const said = await run(`rm -rf ${quote(path)}`);
            if (said.code !== 0) throw new Error(said.stderr.trim() || `could not delete ${path} on ${machine}`);
        },
        trash(path) {
            return trashThrough(run, path);
        },
        async backupRoot(session) {
            if (home === null) {
                const said = await run('printf %s "$HOME"');
                home = said.code === 0 && said.stdout.trim() !== '' ? said.stdout.trim() : '/tmp';
            }
            return `${home}/.rho/undo/${session}`;
        },
    };
}
