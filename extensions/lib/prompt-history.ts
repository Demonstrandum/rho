// prompt history state machine for extensions/prompt-history.ts. no UI, no pi
// imports, so the persistence and deduplication rules can be tested alone.
//
// two machines live here: HistoryLog, which owns what is recorded and kept,
// and ReverseSearch, which owns what an incremental search over the log is
// looking at right now.
//
// the log holds both sent prompts and unsent drafts, newest first. an unsent
// draft is one that was abandoned by navigating away (arrow-up while text was
// in the editor) or by exiting without sending. entries are deduplicated on
// identical adjacent text, so pressing arrow-up and then arrow-down does not
// double-record the same draft.

import { oneLine, truncate } from './text';

export type HistoryEntryId = number & { readonly __historyEntryId: unique symbol };

export interface HistoryEntry {
    readonly id: HistoryEntryId;
    readonly text: string;
    readonly at: number;
    readonly sent: boolean;
}

export const HISTORY_STATE_VERSION = 1;

export interface HistoryState {
    readonly version: typeof HISTORY_STATE_VERSION;
    readonly entries: readonly HistoryEntry[];
    readonly nextId: number;
}

function isEntry(raw: unknown): raw is HistoryEntry {
    if (typeof raw !== 'object' || raw === null) return false;
    const e = raw as Record<string, unknown>;
    return (
        typeof e.id === 'number' &&
        typeof e.text === 'string' &&
        typeof e.at === 'number' &&
        typeof e.sent === 'boolean'
    );
}

export function parseHistoryState(raw: unknown): HistoryState | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (s.version !== HISTORY_STATE_VERSION) return null;
    if (!Array.isArray(s.entries) || !s.entries.every(isEntry)) return null;
    if (typeof s.nextId !== 'number' || !Number.isInteger(s.nextId) || s.nextId < 1) return null;
    const entries = s.entries as readonly HistoryEntry[];
    // an id counter behind the highest id in the log would hand out duplicates
    const highest = entries.reduce((max, e) => Math.max(max, e.id), 0);
    return { version: HISTORY_STATE_VERSION, entries, nextId: Math.max(s.nextId, highest + 1) };
}

export interface HistoryLogOptions {
    readonly initial?: HistoryState | null;
    readonly maxEntries?: number;
    readonly onChange?: (state: HistoryState) => void;
}

/**
 * append-only log of prompts, both sent and unsent. the log is capped by
 * maxEntries and deduplicates identical adjacent text.
 */
export class HistoryLog {
    private entries: HistoryEntry[];
    private nextId: number;
    private readonly maxEntries: number;
    private readonly onChange?: (state: HistoryState) => void;

    constructor(options: HistoryLogOptions = {}) {
        const initial = options.initial;
        this.entries = initial ? [...initial.entries] : [];
        this.nextId = initial?.nextId ?? 1;
        this.maxEntries = options.maxEntries ?? 500;
        this.onChange = options.onChange;
    }

    private allocId(): HistoryEntryId {
        return this.nextId++ as HistoryEntryId;
    }

    private persist(): void {
        this.onChange?.(this.state());
    }

    private cap(): void {
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(0, this.maxEntries);
        }
    }

    state(): HistoryState {
        return { version: HISTORY_STATE_VERSION, entries: this.entries, nextId: this.nextId };
    }

    get size(): number {
        return this.entries.length;
    }

    /** all entries, newest first */
    all(): readonly HistoryEntry[] {
        return this.entries;
    }

    /** entries matching a substring, case-insensitive */
    search(query: string): readonly HistoryEntry[] {
        const lower = query.toLowerCase();
        return this.entries.filter((e) => e.text.toLowerCase().includes(lower));
    }

    /**
     * record a prompt. deduplicates against the most recent entry with the
     * same sent status: recording the same sent text twice in a row does
     * nothing, and recording the same draft twice in a row does nothing.
     */
    record(text: string, sent: boolean): HistoryEntry | null {
        const trimmed = text.trim();
        if (!trimmed) return null;
        // deduplicate against the newest entry of the same kind
        const newest = this.entries.find((e) => e.sent === sent);
        if (newest && newest.text === trimmed) return null;
        const entry: HistoryEntry = {
            id: this.allocId(),
            text: trimmed,
            at: Date.now(),
            sent,
        };
        this.entries.unshift(entry);
        this.cap();
        this.persist();
        return entry;
    }

    /** remove an entry by id */
    remove(id: HistoryEntryId): boolean {
        const index = this.entries.findIndex((e) => e.id === id);
        if (index === -1) return false;
        this.entries.splice(index, 1);
        this.persist();
        return true;
    }

    /** clear all entries */
    clear(): void {
        if (this.entries.length === 0) return;
        this.entries = [];
        this.persist();
    }

    /** restore a previously removed entry (for undo). inserts by timestamp. */
    restore(entry: HistoryEntry): void {
        // find the right position by timestamp (newest first)
        const index = this.entries.findIndex((e) => e.at < entry.at);
        if (index === -1) {
            this.entries.push(entry);
        } else {
            this.entries.splice(index, 0, entry);
        }
        // ensure nextId stays ahead of all ids
        if (entry.id >= this.nextId) {
            this.nextId = entry.id + 1;
        }
        this.persist();
    }
}

/** one line of an entry, cut around the match so the match itself stays visible. */
export interface MatchWindow {
    readonly text: string;
    /** where the match starts in `text`, or -1 when it is not in the window */
    readonly start: number;
    readonly length: number;
}

const MARKER = '...';

/**
 * flatten `text` to one line and cut it to `budget` columns, keeping the first
 * match of `query` inside the cut with about a third of the budget ahead of it.
 * head truncation alone would hide the match that selected the entry.
 */
export function matchWindow(text: string, query: string, budget: number): MatchWindow {
    const line = oneLine(text);
    const at = query ? line.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (line.length <= budget) return { text: line, start: at, length: at === -1 ? 0 : query.length };
    if (at === -1) return { text: truncate(line, budget, MARKER), start: -1, length: 0 };

    // the markers cost columns, so the match has to fit in what is left of the
    // budget after both of them, whichever end of the line the window lands on.
    const content = Math.max(query.length, budget - MARKER.length * 2);
    let from = Math.max(0, Math.min(at - Math.floor(content / 3), line.length - content));
    if (at + query.length > from + content) from = Math.max(0, at + query.length - content);

    const head = from > 0 ? MARKER : '';
    let slice = line.slice(from, from + budget - head.length);
    const tail = from + slice.length < line.length ? MARKER : '';
    if (tail) slice = slice.slice(0, Math.max(query.length, slice.length - tail.length));

    const start = head.length + (at - from);
    const inside = at >= from && start + query.length <= head.length + slice.length;
    return { text: head + slice + tail, start: inside ? start : -1, length: inside ? query.length : 0 };
}

export interface SearchView {
    readonly query: string;
    readonly matches: readonly HistoryEntry[];
    /** position of the current match, or -1 when nothing matches */
    readonly index: number;
    readonly current: HistoryEntry | null;
}

/**
 * an incremental search over a snapshot of the log, newest first. the snapshot
 * is taken once so that a draft recorded while the search is open cannot
 * reorder what is under the cursor.
 *
 * entries with identical text collapse to the newest of them: a prompt that was
 * abandoned as a draft and later sent is one candidate, not two.
 */
export class ReverseSearch {
    private readonly candidates: readonly HistoryEntry[];
    private matched: readonly HistoryEntry[];
    private query = '';
    private index = 0;

    constructor(entries: readonly HistoryEntry[]) {
        const seen = new Set<string>();
        const unique: HistoryEntry[] = [];
        for (const entry of entries) {
            if (seen.has(entry.text)) continue;
            seen.add(entry.text);
            unique.push(entry);
        }
        this.candidates = unique;
        this.matched = unique;
    }

    get view(): SearchView {
        const current = this.matched[this.index] ?? null;
        return {
            query: this.query,
            matches: this.matched,
            index: current === null ? -1 : this.index,
            current,
        };
    }

    /**
     * narrow or widen the search. the entry under the cursor is kept when it
     * still matches, so deleting a character does not jump somewhere else.
     */
    setQuery(query: string): SearchView {
        const held = this.matched[this.index] ?? null;
        this.query = query;
        const lower = query.toLowerCase();
        this.matched = lower
            ? this.candidates.filter((e) => e.text.toLowerCase().includes(lower))
            : this.candidates;
        const kept = held === null ? -1 : this.matched.findIndex((e) => e.id === held.id);
        this.index = kept === -1 ? 0 : kept;
        return this.view;
    }

    /** step towards older entries, stopping at the oldest match. */
    older(): SearchView {
        if (this.index + 1 < this.matched.length) this.index++;
        return this.view;
    }

    /** step back towards newer entries, stopping at the newest match. */
    newer(): SearchView {
        if (this.index > 0) this.index--;
        return this.view;
    }

    /** jump to a match by position, ignoring a position outside the matches. */
    select(index: number): SearchView {
        if (index >= 0 && index < this.matched.length) this.index = index;
        return this.view;
    }
}
