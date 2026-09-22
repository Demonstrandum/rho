#!/usr/bin/env bun
// runs the install that `pi install <rho>` runs, on a tree that has never seen
// `bun install`.
//
// the smoke test could not catch an npm resolution failure: its image runs
// `bun install` first, and bun does not enforce peer ranges, so node_modules
// is already populated by the time npm sees the package. every user installing
// from git meets npm cold instead, and a bundled extension whose peer range
// names an old pi aborts the whole install before any script runs.
//
//   bun ci/install-check.ts          check the working tree
//   bun ci/install-check.ts --keep   keep the temporary tree and print its path
//
// it needs npm and a globally installed pi; the packages below are linked from
// pi rather than fetched.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const KEEP = process.argv.includes('--keep');

/** what an extension imports at run time, and must resolve after the install. */
const REQUIRED_IMPORTS = [
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    'typebox',
] as const;

interface PiManifest {
    readonly extensions?: readonly string[];
    readonly skills?: readonly string[];
    readonly prompts?: readonly string[];
    readonly themes?: readonly string[];
}

/**
 * the bundled resources rho names by path. a bundled package has no entry
 * point to import (token-rate-pi exports only its extension file), so the
 * path pi loads is what must exist.
 */
function bundledPaths(): readonly string[] {
    const manifest = (require(join(REPO, 'package.json')) as { pi: PiManifest }).pi;
    const listed = [manifest.extensions, manifest.skills, manifest.prompts, manifest.themes];
    return listed.flatMap((paths) => paths ?? []).filter((path) => path.startsWith('node_modules/'));
}

function fail(message: string): never {
    console.error(`install-check: ${message}`);
    process.exit(1);
}

/** the tracked tree at its working-tree contents, without node_modules. */
function exportTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'rho-install-'));
    const stash = join(root, 'tree.tar');
    // `git stash` is not used anywhere here: the archive is built from the
    // index refreshed against the working tree, which touches nothing.
    execFileSync('sh', ['-c', `git -C ${JSON.stringify(REPO)} ls-files -z | tar -cf ${JSON.stringify(stash)} -C ${JSON.stringify(REPO)} --null -T -`]);
    execFileSync('tar', ['-xf', stash, '-C', root]);
    rmSync(stash);
    return root;
}

const tree = exportTree();
console.log(`install-check: tree at ${tree}`);

if (existsSync(join(tree, 'node_modules'))) fail('the exported tree already has node_modules; the check would prove nothing.');

const install = spawnSync('npm', ['install', '--omit=dev'], {
    cwd: tree,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_update_notifier: 'false' },
});

const output = `${install.stdout ?? ''}${install.stderr ?? ''}`;
if (install.status !== 0) {
    console.error(output.split('\n').slice(-30).join('\n'));
    fail(`npm install --omit=dev exited ${install.status}. this is the command \`pi install\` runs, so rho cannot be installed.`);
}

const bundled = bundledPaths();
const missing = bundled.filter((path) => !existsSync(join(tree, path)));
if (missing.length > 0) fail(`npm install succeeded but these bundled resources are absent, so pi cannot load them: ${missing.join(', ')}.`);

// resolution, not just presence: a symlink to a package that pi no longer ships
// is a directory entry that resolves to nothing.
const probe = REQUIRED_IMPORTS.map((pkg) => `import(${JSON.stringify(pkg)}).catch((err) => { console.error(${JSON.stringify(pkg)}, String(err)); process.exit(1); })`).join(';\n');
const resolved = spawnSync('bun', ['-e', probe], { cwd: tree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (resolved.status !== 0) {
    console.error(resolved.stderr);
    fail('a package installed but did not import from the installed tree.');
}

if (KEEP) console.log(`install-check: kept ${tree}`);
else rmSync(tree, { recursive: true, force: true });

console.log(`install-check: ok, ${bundled.length} bundled resources present, ${REQUIRED_IMPORTS.length} packages import.`);
