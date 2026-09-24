// finds pi's launcher script and points its shebang at bun.
//
// pi ships `dist/bundle/cli.js` with `#!/usr/bin/env node`, and the shim on PATH
// is a symlink to that file, so the interpreter is chosen by that one line. rho
// is written against bun: two of its extensions read the work tree with
// Bun.spawn, and under node that call raises a ReferenceError which their catch
// turns into "not a git repo". the prompt then states a falsehood about the
// directory, with nothing on screen to say why.
//
// every `pi update` reinstalls the package and restores the node shebang, so a
// one-off manual edit does not hold. this module is the edit, expressed once, and
// run both at install time (tools/bun-shebang.ts) and at startup
// (extensions/bun-runtime.ts).
//
// only the first line is rewritten, and only when it names node. a shebang that
// names anything else is left alone and reported: it means the install is not the
// shape this assumes, and guessing at it would break a working launcher.

import { readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BUN_SHEBANG = '#!/usr/bin/env bun';

/** which interpreter a launcher's first line names. */
export type Interpreter = 'bun' | 'node' | 'other' | 'none';

export interface Launcher {
    readonly path: string;
    /** the file's first line, without its newline. */
    readonly shebang: string;
    readonly interpreter: Interpreter;
}

/**
 * the outcome of one repair attempt. every failure carries what was tried, so
 * the caller can print a note that names the file rather than the symptom.
 */
export type Repair =
    | { readonly kind: 'already-bun'; readonly launcher: Launcher }
    | { readonly kind: 'patched'; readonly launcher: Launcher }
    | { readonly kind: 'not-found'; readonly detail: string }
    | { readonly kind: 'unreadable'; readonly path: string; readonly detail: string }
    | { readonly kind: 'foreign'; readonly launcher: Launcher }
    | { readonly kind: 'unwritable'; readonly launcher: Launcher; readonly detail: string };

export const isBunRuntime = (): boolean => process.versions.bun !== undefined;

/** the interpreter named by a shebang line, by basename rather than by full path. */
export const classify = (shebang: string): Interpreter => {
    const match = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(shebang);
    if (match === null) return 'none';
    const [, command, argument] = match;
    // `#!/usr/bin/env node` names the interpreter in the argument; a direct
    // `#!/opt/homebrew/bin/node` names it in the command.
    const named = command!.endsWith('/env') && argument !== undefined ? argument : command!;
    const base = named.split('/').pop() ?? named;
    if (base === 'bun') return 'bun';
    if (base === 'node' || base === 'node.exe') return 'node';
    return 'other';
};

export const readLauncher = (path: string): Launcher | { readonly detail: string } => {
    try {
        const text = readFileSync(path, 'utf8');
        const shebang = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
        return { path, shebang, interpreter: classify(shebang) };
    } catch (error) {
        return { detail: error instanceof Error ? error.message : String(error) };
    }
};

/** rewrite the first line to name bun, preserving the rest of the file byte for byte. */
export const patch = (launcher: Launcher): Repair => {
    if (launcher.interpreter === 'bun') return { kind: 'already-bun', launcher };
    if (launcher.interpreter !== 'node') return { kind: 'foreign', launcher };
    try {
        const text = readFileSync(launcher.path, 'utf8');
        const mode = statSync(launcher.path).mode;
        const rest = text.slice(launcher.shebang.length);
        writeFileSync(launcher.path, `${BUN_SHEBANG}${rest}`, 'utf8');
        chmodSync(launcher.path, mode);
        return { kind: 'patched', launcher: { ...launcher, shebang: BUN_SHEBANG, interpreter: 'bun' } };
    } catch (error) {
        return {
            kind: 'unwritable',
            launcher,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
};

/**
 * PATH without any node_modules/.bin entry. `bun run` prepends it, and rho
 * carries pi as a devDependency, so an unfiltered lookup answers with rho's own
 * copy instead of the install being launched.
 */
const userPath = (): string =>
    (process.env.PATH ?? '')
        .split(':')
        .filter((entry) => !entry.includes(join('node_modules', '.bin')))
        .join(':');

const commandPath = (command: string): string | null => {
    try {
        const out = execFileSync('sh', ['-c', `command -v ${command}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, PATH: userPath() },
        }).trim();
        return out === '' ? null : out;
    } catch {
        return null;
    }
};

/** bun's own path, for re-running a launcher without relying on its shebang. */
export const bunBinary = (): string | null => {
    const running = process.execPath;
    if (isBunRuntime() && running !== '') return running;
    return commandPath('bun');
};

/**
 * pi's entry script. under node, argv[1] is that script with symlinks resolved,
 * which is the file carrying the shebang; the PATH lookup is the fallback for
 * every other way this module can be called (a tool, a test, an rpc host).
 */
export const findLauncher = (): string | null => {
    const running = process.argv[1];
    if (running !== undefined && running.endsWith('.js')) {
        try {
            return realpathSync(running);
        } catch {
            return running;
        }
    }
    const shim = commandPath('pi');
    if (shim === null) return null;
    try {
        return realpathSync(shim);
    } catch {
        return shim;
    }
};

/** the other entry point in the same bundle directory, used by `pi --rpc`. */
const SIBLINGS = ['rpc-entry.js'] as const;

/**
 * repair pi's entry script and its siblings. the first result is always the
 * primary launcher, since that is the one the caller must decide on.
 */
export const repairLaunchers = (primary: string | null = findLauncher()): readonly Repair[] => {
    if (primary === null) {
        return [{ kind: 'not-found', detail: 'pi is not on PATH and argv[1] is not a script' }];
    }
    const paths = [primary, ...SIBLINGS.map((name) => join(dirname(primary), name))];
    const results: Repair[] = [];
    for (const path of paths) {
        const launcher = readLauncher(path);
        if ('detail' in launcher) {
            // a missing sibling is not a fault; a missing primary is.
            if (path === primary) results.push({ kind: 'unreadable', path, detail: launcher.detail });
            continue;
        }
        results.push(patch(launcher));
    }
    return results;
};

export const describe = (repair: Repair): string => {
    switch (repair.kind) {
        case 'already-bun':
            return `${repair.launcher.path} already runs under bun`;
        case 'patched':
            return `${repair.launcher.path}: shebang now ${BUN_SHEBANG}`;
        case 'not-found':
            return `pi's launcher was not found: ${repair.detail}`;
        case 'unreadable':
            return `${repair.path} could not be read: ${repair.detail}`;
        case 'foreign':
            return `${repair.launcher.path} starts with "${repair.launcher.shebang}", which names neither node nor bun; left alone`;
        case 'unwritable':
            return `${repair.launcher.path} could not be written: ${repair.detail}`;
    }
};
