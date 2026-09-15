import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryCount, freePath, rehomed, sessionIdOf } from '../extensions/lib/remote/transfer';

const session = (id: string, cwd: string, entries: number): string =>
    [
        JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
        ...Array.from({ length: entries }, (_, index) =>
            JSON.stringify({ type: 'message', id: `e${index}`, message: { role: 'user', content: 'hello' } }),
        ),
        '',
    ].join('\n');

describe('a session file crossing between machines', () => {
    test('keeps the identity that says it is one conversation', () => {
        expect(sessionIdOf(session('abc123', '/Users/samuel/Code/rho', 2))).toBe('abc123');
    });

    test('works in the directory of the machine it lands on', () => {
        const carried = rehomed(session('abc123', '/Users/samuel/Code/rho', 2), '/home/samuel/projects/rho');
        const header = JSON.parse(carried.split('\n')[0] ?? '{}') as { id?: string; cwd?: string };
        expect(header.cwd).toBe('/home/samuel/projects/rho');
        expect(header.id).toBe('abc123');
    });

    test('carries every entry it arrived with', () => {
        const before = session('abc123', '/a', 3);
        expect(entryCount(before)).toBe(3);
        expect(entryCount(rehomed(before, '/b'))).toBe(3);
    });

    test('a file with no header is left as it is', () => {
        const stray = '{"type":"message"}\n';
        expect(rehomed(stray, '/b')).toBe(stray);
        expect(sessionIdOf(stray)).toBeNull();
    });

    test('a fresh session has nothing to carry', () => {
        expect(entryCount(session('abc123', '/a', 0))).toBe(0);
    });
});

describe('where a carried conversation is written', () => {
    test('takes the name it arrived with when nothing is using it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'rho-transfer-'));
        expect(freePath(dir, 'abc123.jsonl')).toBe(join(dir, 'abc123.jsonl'));
    });

    test('does not write over a file another session may have open', () => {
        const dir = mkdtempSync(join(tmpdir(), 'rho-transfer-'));
        writeFileSync(join(dir, 'abc123.jsonl'), '');
        expect(freePath(dir, 'abc123.jsonl')).toBe(join(dir, 'abc123-1.jsonl'));
        writeFileSync(join(dir, 'abc123-1.jsonl'), '');
        expect(freePath(dir, 'abc123.jsonl')).toBe(join(dir, 'abc123-2.jsonl'));
    });
});
