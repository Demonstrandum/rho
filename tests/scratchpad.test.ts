import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, scratchDir, scratchRoot, staleDirs } from '../extensions/lib/scratchpad';

const temps: string[] = [];
const workspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'rho-scratch-test-'));
    temps.push(dir);
    return dir;
};

afterEach(() => {
    while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('scratchRoot', () => {
    test('project keeps the directory inside the working tree', () => {
        expect(scratchRoot('project', '/w')).toBe('/w/.rho/scratch');
    });

    test('data-dir leaves the working tree alone', () => {
        const root = scratchRoot('data-dir', '/w');
        expect(root).not.toBeNull();
        expect(root!.startsWith('/w')).toBe(false);
        expect(root!.endsWith(join('scratch'))).toBe(true);
    });

    test('off has no root', () => {
        expect(scratchRoot('off', '/w')).toBeNull();
    });
});

describe('scratchDir', () => {
    test('two sessions in one project do not share a directory', () => {
        const a = scratchDir('project', { cwd: '/w', sessionId: 'aaa' });
        const b = scratchDir('project', { cwd: '/w', sessionId: 'bbb' });
        expect(a).not.toBe(b);
    });

    test('an in-memory session gets a named fallback rather than the root', () => {
        expect(scratchDir('project', { cwd: '/w', sessionId: undefined }))
            .toBe('/w/.rho/scratch/no-session');
    });
});

describe('staleDirs', () => {
    test('reports only directories past the cutoff', () => {
        const root = workspace();
        mkdirSync(join(root, 'old'));
        mkdirSync(join(root, 'fresh'));
        const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        utimesSync(join(root, 'old'), ancient, ancient);
        expect(staleDirs(root, 7)).toEqual([join(root, 'old')]);
    });

    test('files at the root are left alone', () => {
        const root = workspace();
        writeFileSync(join(root, 'note.txt'), 'x');
        expect(staleDirs(root, 0)).toEqual([]);
    });

    test('a missing root is not an error', () => {
        expect(staleDirs('/nonexistent-rho-scratch-root', 7)).toEqual([]);
    });
});

describe('prepare', () => {
    test('creates the directory and prunes a stale sibling', () => {
        const cwd = workspace();
        const root = join(cwd, '.rho', 'scratch');
        mkdirSync(join(root, 'gone'), { recursive: true });
        const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        utimesSync(join(root, 'gone'), ancient, ancient);

        const dir = prepare('project', { cwd, sessionId: 'live' }, 7);
        expect(dir).toBe(join(root, 'live'));
        expect(existsSync(dir!)).toBe(true);
        expect(existsSync(join(root, 'gone'))).toBe(false);
    });

    test('off creates nothing', () => {
        const cwd = workspace();
        expect(prepare('off', { cwd, sessionId: 'live' }, 7)).toBeNull();
        expect(existsSync(join(cwd, '.rho'))).toBe(false);
    });
});
