import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    localStore,
    parseDigestLine,
    parseStatLine,
    trashThrough,
    trashedAt,
    type Said,
} from '../extensions/lib/files/file-store';
import {
    describe as describeEntry,
    keep,
    look,
    pick,
    revert,
    unchanged,
    type UndoEntry,
} from '../extensions/lib/files/undo-journal';

const limits = { maxEntries: 10, maxBytes: 1_000_000 };
const store = localStore();

function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'rho-undo-'));
}

function entry(partial: Partial<UndoEntry> & Pick<UndoEntry, 'path' | 'before' | 'after'>): UndoEntry {
    return {
        id: 1,
        at: '2026-01-01T00:00:00.000Z',
        tool: 'write',
        machine: 'local',
        trashed: null,
        ...partial,
    };
}

describe('keep and revert', () => {
    test('a write is taken back to the bytes that were there', async () => {
        const dir = scratch();
        const path = join(dir, 'tmp.txt');
        writeFileSync(path, 'hello world\n');

        const before = await keep(store, path, join(dir, 'backup', 'tmp.txt'), limits);
        expect(before.kind).toBe('saved');

        writeFileSync(path, 'goodbye world\n');
        const after = await look(store, path);

        const outcome = await revert(store, entry({ path, before, after }));
        expect(outcome).toEqual({ kind: 'restored', from: 'backup' });
        expect(readFileSync(path, 'utf8')).toBe('hello world\n');
    });

    test('a file created by the mutation is removed again', async () => {
        const dir = scratch();
        const path = join(dir, 'new.txt');
        const before = await keep(store, path, join(dir, 'backup', 'new.txt'), limits);
        expect(before).toEqual({ kind: 'absent' });

        writeFileSync(path, 'made\n');
        const outcome = await revert(store, entry({ path, before, after: await look(store, path) }));
        expect(outcome).toEqual({ kind: 'restored', from: 'deletion' });
        expect(existsSync(path)).toBe(false);
    });

    test('a file touched since the mutation is left alone', async () => {
        const dir = scratch();
        const path = join(dir, 'tmp.txt');
        writeFileSync(path, 'first\n');
        const before = await keep(store, path, join(dir, 'backup', 'tmp.txt'), limits);
        writeFileSync(path, 'second\n');
        const after = await look(store, path);

        writeFileSync(path, 'somebody else\n');
        const outcome = await revert(store, entry({ path, before, after }));
        expect(outcome.kind).toBe('changed');
        expect(readFileSync(path, 'utf8')).toBe('somebody else\n');
    });

    test('a removed file comes back out of the trash when the trash said where', async () => {
        const dir = scratch();
        const path = join(dir, 'gone.txt');
        const bin = join(dir, 'Trash');
        mkdirSync(bin);
        writeFileSync(path, 'contents\n');
        const before = await keep(store, path, join(dir, 'backup', 'gone.txt'), limits);
        await store.move(path, join(bin, 'gone.txt'));

        const outcome = await revert(
            store,
            entry({ tool: 'remove', path, before, after: { kind: 'absent' }, trashed: join(bin, 'gone.txt') }),
        );
        expect(outcome).toEqual({ kind: 'restored', from: 'trash' });
        expect(readFileSync(path, 'utf8')).toBe('contents\n');
        expect(existsSync(join(bin, 'gone.txt'))).toBe(false);
    });

    test('a file over the size limit is recorded with nothing to put back', async () => {
        const dir = scratch();
        const path = join(dir, 'big.txt');
        writeFileSync(path, 'x'.repeat(64));
        const before = await keep(store, path, join(dir, 'backup', 'big.txt'), { maxEntries: 10, maxBytes: 8 });
        expect(before).toEqual({ kind: 'unsaved', why: 'too-large', bytes: 64 });

        writeFileSync(path, 'replaced\n');
        const outcome = await revert(store, entry({ path, before, after: await look(store, path) }));
        expect(outcome.kind).toBe('unrecoverable');
        expect(readFileSync(path, 'utf8')).toBe('replaced\n');
    });

    test('a directory is kept whole', async () => {
        const dir = scratch();
        const tree = join(dir, 'tree');
        mkdirSync(join(tree, 'inner'), { recursive: true });
        writeFileSync(join(tree, 'inner', 'leaf.txt'), 'leaf\n');

        const before = await keep(store, tree, join(dir, 'backup', 'tree'), limits);
        expect(before.kind).toBe('directory');
        await store.delete(tree);

        const outcome = await revert(store, entry({ tool: 'remove', path: tree, before, after: { kind: 'absent' } }));
        expect(outcome).toEqual({ kind: 'restored', from: 'backup' });
        expect(readFileSync(join(tree, 'inner', 'leaf.txt'), 'utf8')).toBe('leaf\n');
    });
});

describe('selection', () => {
    const entries: readonly UndoEntry[] = [
        entry({ id: 1, path: '/a', before: { kind: 'absent' }, after: { kind: 'absent' } }),
        entry({ id: 2, path: '/b', before: { kind: 'absent' }, after: { kind: 'absent' } }),
        entry({ id: 3, path: '/a', before: { kind: 'absent' }, after: { kind: 'absent' } }),
    ];

    test('the newest mutation comes first', () => {
        expect(pick(entries, { count: 1 }).map((e) => e.id)).toEqual([3]);
    });

    test('a path selects only its own mutations', () => {
        expect(pick(entries, { path: '/a', count: 5 }).map((e) => e.id)).toEqual([3, 1]);
    });

    test('a count below one still takes one', () => {
        expect(pick(entries, { count: 0 })).toHaveLength(1);
    });
});

describe('staleness', () => {
    test('the digest decides when both sides have one', () => {
        expect(unchanged({ kind: 'file', digest: 'aa', bytes: 4 }, { kind: 'file', bytes: 4 }, 'aa')).toBe(true);
        expect(unchanged({ kind: 'file', digest: 'aa', bytes: 4 }, { kind: 'file', bytes: 4 }, 'bb')).toBe(false);
    });

    test('the size decides when the machine produced no digest', () => {
        expect(unchanged({ kind: 'file', digest: null, bytes: 4 }, { kind: 'file', bytes: 4 }, null)).toBe(true);
        expect(unchanged({ kind: 'file', digest: null, bytes: 4 }, { kind: 'file', bytes: 5 }, null)).toBe(false);
    });

    test('a file where the mutation left nothing is a change', () => {
        expect(unchanged({ kind: 'absent' }, { kind: 'file', bytes: 1 }, 'aa')).toBe(false);
    });
});

describe('reading what a machine said', () => {
    test('a stat line', () => {
        expect(parseStatLine('absent')).toEqual({ kind: 'absent' });
        expect(parseStatLine('directory')).toEqual({ kind: 'directory' });
        expect(parseStatLine('  12\n')).toEqual({ kind: 'file', bytes: 12 });
    });

    test('a digest line from either sha256 tool', () => {
        const hash = 'a'.repeat(64);
        expect(parseDigestLine(`${hash}  ./file`)).toBe(hash);
        expect(parseDigestLine('sha256sum: not found')).toBeNull();
    });

    test('the destination /usr/bin/trash reports', () => {
        expect(trashedAt('# Moved "/tmp/a.txt" to "/Users/s/.Trash/a.txt"')).toBe('/Users/s/.Trash/a.txt');
        expect(trashedAt('moved it somewhere')).toBeNull();
    });

    test('the first trash command present is the one used', async () => {
        const seen: string[] = [];
        const run = (command: string): Promise<Said> => {
            seen.push(command);
            if (command === 'command -v trash') return Promise.resolve({ code: 1, stdout: '', stderr: '' });
            if (command === 'command -v gio') return Promise.resolve({ code: 0, stdout: '/usr/bin/gio\n', stderr: '' });
            return Promise.resolve({ code: 0, stdout: '', stderr: '' });
        };
        expect(await trashThrough(run, '/tmp/x')).toEqual({ kind: 'trashed', at: null });
        expect(seen).toContain("gio trash '/tmp/x'");
    });

    test('a machine with no trash command refuses rather than deleting', async () => {
        const run = (): Promise<Said> => Promise.resolve({ code: 1, stdout: '', stderr: '' });
        const outcome = await trashThrough(run, '/tmp/x');
        expect(outcome.kind).toBe('failed');
    });
});

test('an entry describes itself in one line', () => {
    const line = describeEntry(
        entry({ id: 4, path: '/tmp/a.txt', before: { kind: 'saved', backup: '/b', bytes: 12, digest: null }, after: { kind: 'absent' } }),
    );
    expect(line).toContain('4. write /tmp/a.txt');
    expect(line).toContain('12 bytes kept');
});
