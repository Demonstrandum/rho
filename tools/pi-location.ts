// where pi's own @earendil-works packages live.
//
// two traps, both hit in practice:
//
// - `bun run` prepends node_modules/.bin to PATH, and rho has pi as a
//   devDependency, so a plain `which pi` answers with rho's own copy. linking
//   rho's packages to that copy makes each link point at itself, and every
//   import of pi-tui or pi-coding-agent then fails to resolve.
// - pi's entry has moved between releases (dist/cli.js, dist/bundle/cli.js), so
//   a fixed number of `..` steps from it lands somewhere different per version.
//   walking up to the directory named @earendil-works does not care.

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCOPE = '@earendil-works';

/** PATH without any node_modules/.bin entry. */
export function userPath(): string {
    return (process.env.PATH ?? '')
        .split(':')
        .filter((entry) => !entry.includes(join('node_modules', '.bin')))
        .join(':');
}

/** the installed pi executable, ignoring any project-local copy. */
export function findPiBinary(): string | null {
    try {
        const out = execFileSync('sh', ['-c', 'command -v pi'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, PATH: userPath() },
        }).trim();
        return out === '' ? null : out;
    } catch {
        return null;
    }
}

/** the @earendil-works directory holding pi's packages. */
export function findPiScope(piBin: string | null = findPiBinary()): string | null {
    if (!piBin) return null;
    let current: string;
    try {
        current = realpathSync(piBin);
    } catch {
        return null;
    }
    for (let depth = 0; depth < 12; depth += 1) {
        const parent = dirname(current);
        if (parent === current) return null;
        if (basename(parent) === SCOPE && existsSync(join(parent, 'pi-coding-agent'))) return parent;
        current = parent;
    }
    return null;
}
