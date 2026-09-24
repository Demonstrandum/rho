#!/usr/bin/env bun
// move modules and repair every import that named them.
//
//   bun tools/regroup.ts <plan.json>        move, then rewrite
//   bun tools/regroup.ts <plan.json> --dry  say what would move
//
// the plan is { "old/path.ts": "new/path.ts" }, relative to the repo root.
//
// a rename done with sed leaves the imports that spelled the path another way,
// and there are four spellings of every module here (from a sibling, from a
// parent, from tests/, from tools/). so each import is resolved to the file it
// names, looked up in the plan, and written back as the path from wherever the
// importing file now is. nothing is matched textually except the specifier.
//
// one pass, one commit: `git mv` keeps the history, and `--dry` says what the
// plan does before it does it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), '..');
const SOURCES = ['extensions', 'tools', 'tests', 'ci'];

const planPath = process.argv[2];
const dry = process.argv.includes('--dry');
if (planPath === undefined) {
    console.error('usage: bun tools/regroup.ts <plan.json> [--dry]');
    process.exit(1);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, string>;
const moves = new Map<string, string>();
for (const [from, to] of Object.entries(plan)) moves.set(resolve(ROOT, from), resolve(ROOT, to));

for (const from of moves.keys()) {
    if (!existsSync(from)) {
        console.error(`not there: ${relative(ROOT, from)}`);
        process.exit(1);
    }
}

/** every .ts file under the source directories, moved ones included. */
function sources(): string[] {
    const out = execFileSync('git', ['ls-files', ...SOURCES], { cwd: ROOT, encoding: 'utf8' });
    return out
        .split('\n')
        .filter((line) => line.endsWith('.ts'))
        .map((line) => resolve(ROOT, line));
}

/**
 * the file a relative specifier names, or null when it names none.
 *
 * Resolved against the tree as it was before anything moved, because a
 * specifier was written against that tree and the files it names are the ones
 * the plan is keyed on. Asking the filesystem after the moves answers that
 * every old path is gone, and every import is then left as it was.
 */
function target(known: ReadonlySet<string>, from: string, specifier: string): string | null {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
        if (known.has(candidate)) return candidate;
    }
    return null;
}

/** how one file refers to another after both have moved. */
function specifierFor(from: string, to: string): string {
    const path = relative(dirname(from), to).replace(/\.ts$/, '');
    return path.startsWith('.') ? path : `./${path}`;
}

const files = sources();
const before = new Set(files);
if (dry) {
    for (const [from, to] of moves) console.log(`${relative(ROOT, from)} -> ${relative(ROOT, to)}`);
    console.log(`${files.length} files would be scanned for imports`);
    process.exit(0);
}

for (const [from, to] of moves) {
    mkdirSync(dirname(to), { recursive: true });
    execFileSync('git', ['mv', relative(ROOT, from), relative(ROOT, to)], { cwd: ROOT });
}

const SPECIFIER = /(from\s+|import\s*\(\s*)'(\.[^']*)'/g;
let touched = 0;
for (const file of files) {
    // a file that moved is read and written at its new home.
    const at = moves.get(file) ?? file;
    const source = readFileSync(at, 'utf8');
    const rewritten = source.replace(SPECIFIER, (whole, lead: string, specifier: string) => {
        // resolved against where the file used to be, since that is what the
        // specifier was written against.
        const named = target(before, file, specifier);
        if (named === null) return whole;
        const now = moves.get(named) ?? named;
        return `${lead}'${specifierFor(at, now)}'`;
    });
    if (rewritten !== source) {
        writeFileSync(at, rewritten, 'utf8');
        touched += 1;
    }
}

console.log(`moved ${moves.size}, rewrote imports in ${touched}`);
