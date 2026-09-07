// unit tests for the prompt history state machine

import { describe, expect, it, beforeEach } from 'bun:test';
import { HistoryLog, parseHistoryState, HISTORY_STATE_VERSION, type HistoryState, type HistoryEntry, type HistoryEntryId } from '../extensions/lib/prompt-history';

describe('HistoryLog', () => {
    let log: HistoryLog;
    let persisted: HistoryState | null = null;

    beforeEach(() => {
        persisted = null;
        log = new HistoryLog({
            maxEntries: 5,
            onChange: (state) => { persisted = state; },
        });
    });

    it('starts empty', () => {
        expect(log.size).toBe(0);
        expect(log.all()).toEqual([]);
    });

    it('records a sent prompt', () => {
        const entry = log.record('hello', true);
        expect(entry).not.toBeNull();
        expect(entry!.text).toBe('hello');
        expect(entry!.sent).toBe(true);
        expect(log.size).toBe(1);
    });

    it('records an unsent draft', () => {
        const entry = log.record('draft', false);
        expect(entry).not.toBeNull();
        expect(entry!.sent).toBe(false);
    });

    it('trims whitespace', () => {
        const entry = log.record('  spaced  ', true);
        expect(entry!.text).toBe('spaced');
    });

    it('ignores blank text', () => {
        expect(log.record('', true)).toBeNull();
        expect(log.record('   ', true)).toBeNull();
        expect(log.size).toBe(0);
    });

    it('deduplicates adjacent sent prompts', () => {
        log.record('same', true);
        log.record('same', true);
        expect(log.size).toBe(1);
    });

    it('deduplicates adjacent unsent drafts', () => {
        log.record('draft', false);
        log.record('draft', false);
        expect(log.size).toBe(1);
    });

    it('does not deduplicate across sent/unsent', () => {
        log.record('text', true);
        log.record('text', false);
        expect(log.size).toBe(2);
    });

    it('caps at maxEntries', () => {
        for (let i = 0; i < 10; i++) {
            log.record(`prompt ${i}`, true);
        }
        expect(log.size).toBe(5);
        expect(log.all()[0].text).toBe('prompt 9');
    });

    it('persists on change', () => {
        log.record('persisted', true);
        expect(persisted).not.toBeNull();
        expect(persisted!.entries.length).toBe(1);
    });

    it('removes by id', () => {
        const entry = log.record('to remove', true)!;
        expect(log.remove(entry.id)).toBe(true);
        expect(log.size).toBe(0);
    });

    it('clears all', () => {
        log.record('a', true);
        log.record('b', true);
        log.clear();
        expect(log.size).toBe(0);
    });

    it('searches case-insensitively', () => {
        log.record('Hello World', true);
        log.record('goodbye', true);
        const results = log.search('hello');
        expect(results.length).toBe(1);
        expect(results[0].text).toBe('Hello World');
    });

    it('restores a removed entry in correct position', () => {
        // create entries with distinct timestamps
        const base = Date.now();
        const e1: HistoryEntry = { id: 1 as HistoryEntryId, text: 'first', at: base, sent: true };
        const e2: HistoryEntry = { id: 2 as HistoryEntryId, text: 'second', at: base + 100, sent: true };
        const e3: HistoryEntry = { id: 3 as HistoryEntryId, text: 'third', at: base + 200, sent: true };
        const initial: HistoryState = {
            version: HISTORY_STATE_VERSION,
            entries: [e3, e2, e1], // newest first
            nextId: 4,
        };
        const localLog = new HistoryLog({ initial });
        // remove middle entry
        localLog.remove(e2.id);
        expect(localLog.size).toBe(2);
        // restore it
        localLog.restore(e2);
        expect(localLog.size).toBe(3);
        // order should be: third, second, first (by timestamp, newest first)
        const all = localLog.all();
        expect(all[0].id).toBe(e3.id);
        expect(all[1].id).toBe(e2.id);
        expect(all[2].id).toBe(e1.id);
    });
});

describe('parseHistoryState', () => {
    it('parses valid state', () => {
        const raw = {
            version: HISTORY_STATE_VERSION,
            entries: [{ id: 1, text: 'hello', at: 1234567890, sent: true }],
            nextId: 2,
        };
        const parsed = parseHistoryState(raw);
        expect(parsed).not.toBeNull();
        expect(parsed!.entries.length).toBe(1);
    });

    it('rejects wrong version', () => {
        const raw = {
            version: 999,
            entries: [],
            nextId: 1,
        };
        expect(parseHistoryState(raw)).toBeNull();
    });

    it('rejects malformed entries', () => {
        const raw = {
            version: HISTORY_STATE_VERSION,
            entries: [{ id: 'not a number' }],
            nextId: 1,
        };
        expect(parseHistoryState(raw)).toBeNull();
    });

    it('fixes nextId behind highest id', () => {
        const raw = {
            version: HISTORY_STATE_VERSION,
            entries: [{ id: 10, text: 'hello', at: 1234567890, sent: true }],
            nextId: 5,
        };
        const parsed = parseHistoryState(raw);
        expect(parsed!.nextId).toBe(11);
    });
});

describe('HistoryLog with initial state', () => {
    it('restores from valid state', () => {
        const initial: HistoryState = {
            version: HISTORY_STATE_VERSION,
            entries: [
                { id: 1 as any, text: 'old', at: 1000, sent: true },
            ],
            nextId: 2,
        };
        const log = new HistoryLog({ initial });
        expect(log.size).toBe(1);
        expect(log.all()[0].text).toBe('old');
    });
});
