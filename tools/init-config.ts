#!/usr/bin/env bun
// generates rho.toml from the default config.
//
//   bun run init              -> writes to XDG config path
//   bun run init ./rho.toml   -> writes to the given path
//   bun run init -            -> prints to stdout
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { configPath, DEFAULTS, toToml, save } from '../extensions/lib/config';

const arg = process.argv[2] ?? null;
const force = process.argv.includes('--force');

if (arg === '-') {
    process.stdout.write(toToml(DEFAULTS));
    process.exit(0);
}

const dest = resolve(arg ?? configPath);

if (existsSync(dest) && !force) {
    console.log(`config already exists: ${dest}`);
    console.log('use --force to overwrite');
    process.exit(0);
}

save(dest, DEFAULTS);
console.log(`wrote default config to ${dest}`);
