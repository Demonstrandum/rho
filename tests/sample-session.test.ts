import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { SAMPLE_LEAF, sampleEntries } from '../extensions/lib/session/sample-session';
import { sampleArgv } from '../extensions/sample-session';
import { writeSessionCopy } from '../extensions/lib/session/session-file';
import { pathTo, runIds, treeOf, unitRun } from '../extensions/session-tree/edit';

const entries = sampleEntries();

test('every entry names a parent that exists, and only the first names none', () => {
    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.size).toBe(entries.length);
    const rootless = entries.filter((entry) => entry.parentId === null);
    expect(rootless.length).toBe(1);
    expect(rootless[0]).toBe(entries[0]!);
    for (const entry of entries.slice(1)) expect(ids.has(entry.parentId!)).toBe(true);
    expect(treeOf(entries).length).toBe(1);
});

test('a parent is always written before its children, and time runs forward', () => {
    const seen = new Set<string>();
    let last = 0;
    for (const entry of entries) {
        if (entry.parentId !== null) expect(seen.has(entry.parentId)).toBe(true);
        seen.add(entry.id);
        const at = Date.parse(entry.timestamp);
        expect(at).toBeGreaterThanOrEqual(last);
        last = at;
    }
});

test('the sample holds every entry kind a renderer has to draw', () => {
    const kinds = new Set(
        entries.map((entry) => (entry.type === 'message' ? `message:${entry.message.role}` : entry.type)),
    );
    for (const kind of [
        'session_info',
        'model_change',
        'thinking_level_change',
        'label',
        'branch_summary',
        'custom_message',
        'message:user',
        'message:assistant',
        'message:toolResult',
    ]) {
        expect(kinds).toContain(kind);
    }
});

test('it has thinking, an error result, and an aborted reply in it', () => {
    const assistants = entries.filter(
        (entry): entry is Extract<SessionEntry, { type: 'message' }> =>
            entry.type === 'message' && entry.message.role === 'assistant',
    );
    const thinking = assistants.filter((entry) =>
        (entry.message as { content: { type: string }[] }).content.some((part) => part.type === 'thinking'),
    );
    expect(thinking.length).toBeGreaterThanOrEqual(3);
    expect(assistants.some((entry) => (entry.message as { stopReason: string }).stopReason === 'aborted')).toBe(true);
    expect(
        entries.some(
            (entry) => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.isError,
        ),
    ).toBe(true);
});

test('the tree branches more than once, and the leaf is on the branch that was kept', () => {
    const children = new Map<string, number>();
    for (const entry of entries.slice(1)) {
        children.set(entry.parentId!, (children.get(entry.parentId!) ?? 0) + 1);
    }
    expect([...children.values()].filter((count) => count > 1).length).toBeGreaterThanOrEqual(2);
    expect(entries.at(-1)!.id).toBe(SAMPLE_LEAF);
    expect(pathTo(entries, SAMPLE_LEAF).length).toBeGreaterThan(5);
});

test('every tool call is answered, and the pair reads as one unit', () => {
    const calls = new Map<string, string>();
    for (const entry of entries) {
        if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
        for (const part of (entry.message as { content: { type: string; id?: string }[] }).content) {
            if (part.type === 'toolCall') calls.set(part.id!, entry.id);
        }
    }
    const answered = new Set<string>();
    for (const entry of entries) {
        if (entry.type !== 'message' || entry.message.role !== 'toolResult') continue;
        expect(calls.has(entry.message.toolCallId)).toBe(true);
        answered.add(entry.message.toolCallId);
    }
    expect(answered.size).toBe(calls.size);

    const [callId, assistantId] = [...calls.entries()][0]!;
    void callId;
    const path = pathTo(entries, entries.at(-1)!.id);
    if (path.includes(assistantId)) {
        expect(runIds(entries, unitRun(entries, path, assistantId)).length).toBe(2);
    }
});

test('it round-trips through a session file unchanged', () => {
    const dir = mkdtempSync(`${tmpdir()}/rho-sample-`);
    const path = writeSessionCopy({ sessionDir: dir, cwd: '/tmp', entries });
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect((lines[0] as { type: string; cwd: string }).type).toBe('session');
    expect(lines.slice(1)).toEqual(JSON.parse(JSON.stringify(entries)));
});

test('the sample is the same file every time', () => {
    expect(JSON.stringify(sampleEntries())).toBe(JSON.stringify(entries));
});

test('the re-run drops the flag and names the sample file', () => {
    expect(sampleArgv(['--sample-session', '--model', 'x/y'], '/s.jsonl')).toEqual([
        '--model',
        'x/y',
        '--session',
        '/s.jsonl',
    ]);
    expect(sampleArgv(['--sample-session=true', '-c'], '/s.jsonl')).toEqual(['-c', '--session', '/s.jsonl']);
    // a flag that merely starts with the same letters is not this one
    expect(sampleArgv(['--sample-sessions-dir', 'x'], '/s.jsonl')).toEqual([
        '--sample-sessions-dir',
        'x',
        '--session',
        '/s.jsonl',
    ]);
});
