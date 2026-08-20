#!/usr/bin/env bun
// symlink rho's copies of pi's packages to pi's own global copies so they
// share module identity. without this, a class imported here (Box,
// ToolExecutionComponent) is a *different* class from the one pi
// instantiates, and prototype patches silently apply to nothing.
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const PACKAGES = ['pi-tui', 'pi-coding-agent'];

const localScope = join(import.meta.dir, '..', 'node_modules', '@earendil-works');

function warn(msg: string): void {
    console.error(`[link-pi-packages] ${msg}`);
}

function globalScopeDir(): string | null {
    try {
        const piBin = execSync('which pi', { encoding: 'utf8' }).trim();
        // pi is a symlink into the global pi-coding-agent's dist/cli.js
        const target = readlinkSync(piBin);
        const entryDir = dirname(resolve(dirname(piBin), target));
        // .../@earendil-works/pi-coding-agent/dist -> .../@earendil-works
        const scope = resolve(entryDir, '..', '..');
        return existsSync(scope) ? scope : null;
    } catch {
        return null;
    }
}

const scope = globalScopeDir();
if (!scope) {
    warn("could not locate pi's global @earendil-works scope from `which pi`; leaving node_modules untouched. rho extensions may fail to load if their local copies are missing or broken.");
    process.exit(0);
}

for (const pkg of PACKAGES) {
    const target = join(scope, pkg);
    const link = join(localScope, pkg);
    if (!existsSync(target)) {
        warn(`global ${pkg} not found at ${target}; skipping.`);
        continue;
    }

    try {
        const stat = lstatSync(link);
        if (stat.isSymbolicLink()) {
            const current = readlinkSync(link);
            if (current === target) continue; // already linked
            // a self-referential loop (link -> itself) resolves to nothing and
            // makes the package unresolvable; rewrite it below.
            if (resolve(dirname(link), current) === resolve(link)) {
                warn(`${pkg} was a self-referential symlink loop; repairing.`);
            }
        }
    } catch { /* not present yet */ }

    try {
        rmSync(link, { recursive: true, force: true });
        symlinkSync(target, link);
    } catch (err) {
        warn(`failed to link ${pkg} -> ${target}: ${(err as Error).message}. rho's prototype patches will not apply until this is fixed (try re-running \`bun tools/link-pi-packages.ts\`).`);
    }
}
