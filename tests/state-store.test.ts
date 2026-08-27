import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistedState, type StateSpec } from '../extensions/lib/state-store';
import { parseStashState, Stash, STASH_STATE_VERSION } from '../extensions/lib/stash';

interface Counter {
    readonly version: 1;
    readonly count: number;
}

const counter: StateSpec<Counter> = {
    name: 'test-counter',
    scope: 'session',
    parse: (raw) => {
        if (typeof raw !== 'object' || raw === null) return null;
        const s = raw as Record<string, unknown>;
        return s.version === 1 && typeof s.count === 'number' ? { version: 1, count: s.count } : null;
    },
};

function identity(sessionId: string | undefined) {
    return { cwd: mkdtempSync(join(tmpdir(), 'rho-state-')), sessionId };
}

describe('PersistedState', () => {
    test('a written value comes back from a fresh store', () => {
        const id = identity(`round-trip-${process.pid}`);
        const first = PersistedState.open(counter, id);
        expect(first.read()).toBeNull();
        expect(first.write({ version: 1, count: 7 })).toBe(true);

        const second = PersistedState.open(counter, id);
        expect(second.read()).toEqual({ version: 1, count: 7 });
        second.clear();
        expect(second.read()).toBeNull();
    });

    test('a file of the wrong shape reads as no state instead of a bad value', () => {
        const id = identity(`bad-shape-${process.pid}`);
        const store = PersistedState.open(counter, id);
        store.write({ version: 1, count: 1 });
        const file = store.file;
        expect(file).not.toBeNull();
        writeFileSync(file as string, '{"version":2,"count":"nine"}', 'utf8');
        expect(store.read()).toBeNull();
        store.clear();
    });

    test('unparseable json reads as no state and the file is left alone', () => {
        const id = identity(`bad-json-${process.pid}`);
        const store = PersistedState.open(counter, id);
        store.write({ version: 1, count: 1 });
        const file = store.file as string;
        writeFileSync(file, '{ not json', 'utf8');
        expect(store.read()).toBeNull();
        expect(readFileSync(file, 'utf8')).toBe('{ not json');
        store.clear();
        expect(existsSync(file)).toBe(false);
    });

    test('a session without an id gets no file and no state', () => {
        const store = PersistedState.open(counter, identity(undefined));
        expect(store.file).toBeNull();
        expect(store.write({ version: 1, count: 3 })).toBe(false);
        expect(store.read()).toBeNull();
    });

    test('two projects with the same basename keep separate files', () => {
        const spec: StateSpec<Counter> = { ...counter, scope: 'project' };
        const a = PersistedState.open(spec, { cwd: '/tmp/rho-a/work', sessionId: undefined });
        const b = PersistedState.open(spec, { cwd: '/tmp/rho-b/work', sessionId: undefined });
        expect(a.file).not.toBe(b.file);
        expect(a.file).toContain('work-');
    });
});

describe('stash persistence', () => {
    test('the stack and the id counter survive a restore', () => {
        const written: unknown[] = [];
        const stash = new Stash({ onChange: (state) => written.push(state) });
        stash.push('first');
        stash.push('second');
        expect(written.length).toBe(2);

        const restored = new Stash({ initial: parseStashState(JSON.parse(JSON.stringify(stash.snapshot()))) });
        expect(restored.list().map((e) => e.text)).toEqual(['second', 'first']);

        // a fresh id, not one already on the stack.
        restored.push('third');
        const ids = restored.list().map((e) => e.id);
        expect(new Set(ids).size).toBe(3);
    });

    test('a stored counter behind the stack is corrected on parse', () => {
        const state = parseStashState({
            version: STASH_STATE_VERSION,
            entries: [{ id: 9, text: 'kept', at: 1 }],
            nextId: 1,
        });
        expect(state?.nextId).toBe(10);
    });

    test('a state of another version is rejected', () => {
        expect(parseStashState({ version: 99, entries: [], nextId: 1 })).toBeNull();
        expect(parseStashState({ version: STASH_STATE_VERSION, entries: [{ id: 'x' }], nextId: 1 })).toBeNull();
        expect(parseStashState(null)).toBeNull();
    });

    test('every change to the stack reports a state to persist', () => {
        const seen: number[] = [];
        const stash = new Stash({ onChange: (state) => seen.push(state.entries.length) });
        stash.push('a');
        stash.push('b');
        stash.pop('');
        stash.clear();
        stash.undo();
        expect(seen).toEqual([1, 2, 1, 0, 1]);
    });
});
