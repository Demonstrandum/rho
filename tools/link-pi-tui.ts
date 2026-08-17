#!/usr/bin/env bun
// symlink rho's @earendil-works/pi-tui to pi's global copy so they
// share the same module instance. without this, Box.prototype patches
// in extensions don't affect pi's components.
import { existsSync, readlinkSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const localPath = join(import.meta.dir, '..', 'node_modules', '@earendil-works', 'pi-tui');

// find pi's global pi-tui by following the pi binary symlink
try {
    const piBin = execSync('which pi', { encoding: 'utf8' }).trim();
    const piTarget = readlinkSync(piBin);
    const piEntryDir = dirname(resolve(dirname(piBin), piTarget));
    // pi-tui is a sibling package in the global node_modules
    const globalPiTui = resolve(piEntryDir, '..', '..', '@earendil-works', 'pi-tui');

    if (!existsSync(globalPiTui)) {
        console.log('[link-pi-tui] global pi-tui not found at', globalPiTui);
        process.exit(0);
    }

    // check if already symlinked correctly
    try {
        const stat = lstatSync(localPath);
        if (stat.isSymbolicLink() && readlinkSync(localPath) === globalPiTui) {
            process.exit(0); // already correct
        }
    } catch { /* doesn't exist yet */ }

    // remove local copy, symlink to global
    rmSync(localPath, { recursive: true, force: true });
    symlinkSync(globalPiTui, localPath);
} catch {
    // if anything fails (pi not installed, etc.), just leave the local copy alone.
}
