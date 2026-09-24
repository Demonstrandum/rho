import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    BUN_SHEBANG,
    classify,
    patch,
    readLauncher,
    repairLaunchers,
} from '../extensions/lib/core/bun-launcher';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'rho-launcher-'));

const write = (dir: string, name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text, 'utf8');
    chmodSync(path, 0o755);
    return path;
};

describe('classify', () => {
    test('reads the interpreter out of an env shebang', () => {
        expect(classify('#!/usr/bin/env node')).toBe('node');
        expect(classify('#!/usr/bin/env bun')).toBe('bun');
    });

    test('reads a direct interpreter path', () => {
        expect(classify('#!/opt/homebrew/bin/node')).toBe('node');
        expect(classify('#!/Users/x/.bun/bin/bun')).toBe('bun');
    });

    test('names anything else', () => {
        expect(classify('#!/usr/bin/env deno')).toBe('other');
        expect(classify('#!/bin/sh')).toBe('other');
        expect(classify('import x from "y";')).toBe('none');
    });
});

describe('patch', () => {
    test('rewrites only the first line', () => {
        const dir = scratch();
        const path = write(dir, 'cli.js', '#!/usr/bin/env node\nconst x = 1;\n// #!/usr/bin/env node\n');
        const launcher = readLauncher(path);
        expect('detail' in launcher).toBe(false);
        const result = patch(launcher as Exclude<typeof launcher, { detail: string }>);
        expect(result.kind).toBe('patched');
        expect(readFileSync(path, 'utf8')).toBe(
            `${BUN_SHEBANG}\nconst x = 1;\n// #!/usr/bin/env node\n`,
        );
    });

    test('keeps the executable bit', () => {
        const dir = scratch();
        const path = write(dir, 'cli.js', '#!/usr/bin/env node\n');
        const before = statSync(path).mode;
        patch({ path, shebang: '#!/usr/bin/env node', interpreter: 'node' });
        expect(statSync(path).mode).toBe(before);
    });

    test('is idempotent', () => {
        const dir = scratch();
        const path = write(dir, 'cli.js', `${BUN_SHEBANG}\nconst x = 1;\n`);
        const first = repairLaunchers(path);
        expect(first[0]!.kind).toBe('already-bun');
        expect(readFileSync(path, 'utf8')).toBe(`${BUN_SHEBANG}\nconst x = 1;\n`);
    });

    test('leaves a shebang naming neither runtime alone', () => {
        const dir = scratch();
        const path = write(dir, 'cli.js', '#!/usr/bin/env deno\nconst x = 1;\n');
        const result = repairLaunchers(path)[0]!;
        expect(result.kind).toBe('foreign');
        expect(readFileSync(path, 'utf8')).toBe('#!/usr/bin/env deno\nconst x = 1;\n');
    });
});

describe('repairLaunchers', () => {
    test('patches the rpc entry beside the launcher', () => {
        const dir = scratch();
        const cli = write(dir, 'cli.js', '#!/usr/bin/env node\n');
        const rpc = write(dir, 'rpc-entry.js', '#!/usr/bin/env node\n');
        const results = repairLaunchers(cli);
        expect(results.map((r) => r.kind)).toEqual(['patched', 'patched']);
        expect(readFileSync(rpc, 'utf8')).toBe(`${BUN_SHEBANG}\n`);
    });

    test('a missing sibling is not a fault, a missing primary is', () => {
        const dir = scratch();
        const cli = write(dir, 'cli.js', '#!/usr/bin/env node\n');
        expect(repairLaunchers(cli).map((r) => r.kind)).toEqual(['patched']);
        expect(repairLaunchers(join(dir, 'gone.js'))[0]!.kind).toBe('unreadable');
        expect(repairLaunchers(null)[0]!.kind).toBe('not-found');
    });
});
