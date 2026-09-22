#!/usr/bin/env bun
// symlink rho's copies of pi's packages to pi's own global copies so they
// share module identity. without this, a class imported here (Box,
// ToolExecutionComponent) is a *different* class from the one pi
// instantiates, and prototype patches silently apply to nothing.
//
// the links are also how these packages arrive at all for a registry install.
// `pi install` runs `npm install --omit=dev`, which omits rho's dev copies,
// and .npmrc turns off peer resolution, so nothing fetches pi's packages from
// the registry. fetching them would be wrong anyway: a second pi-ai is a
// second typebox registry, and a schema built against one is rejected by the
// other.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findPiScope } from './pi-location';

/** every package an extension imports at run time and pi already ships. */
const PACKAGES = [
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    'typebox',
] as const;

const localModules = join(import.meta.dir, '..', 'node_modules');

function warn(msg: string): void {
    console.error(`[link-pi-packages] ${msg}`);
}

const scope = findPiScope();
if (!scope) {
    warn("could not locate pi's global @earendil-works scope from `which pi`; leaving node_modules untouched. rho extensions may fail to load if their local copies are missing or broken.");
    process.exit(0);
}

// pi's node_modules root, so an unscoped package (typebox) resolves too.
const piModules = dirname(scope);

for (const pkg of PACKAGES) {
    const target = join(piModules, pkg);
    const link = join(localModules, pkg);
    if (!existsSync(target)) {
        warn(`global ${pkg} not found at ${target}; skipping.`);
        continue;
    }
    // a link to itself resolves to nothing, so every import of the package
    // fails. it is what an earlier version of this script produced whenever the
    // scope search answered with rho's own node_modules.
    if (resolve(target) === resolve(link)) {
        warn(`refusing to link ${pkg} to itself at ${link}; is pi installed globally?`);
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
        mkdirSync(dirname(link), { recursive: true });
        rmSync(link, { recursive: true, force: true });
        symlinkSync(target, link);
    } catch (err) {
        warn(`failed to link ${pkg} -> ${target}: ${(err as Error).message}. rho's prototype patches will not apply until this is fixed (try re-running \`bun tools/link-pi-packages.ts\`).`);
    }
}
