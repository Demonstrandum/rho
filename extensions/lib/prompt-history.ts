// prompt history state machine for extensions/prompt-history.ts. no UI, no pi
// imports, so the persistence and deduplication rules can be tested alone.
//
// the log holds both sent prompts and unsent drafts, newest first. an unsent
// draft is one that was abandoned by navigating away (arrow-up while text was
// in the editor) or by exiting without sending. entries are deduplicated on
// identical adjacent text, so pressing arrow-up and then arrow-down does not
// double-record the same draft.

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
}
