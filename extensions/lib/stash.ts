// stash state machine for extensions/stash.ts. no UI, no pi imports, so the
// cycling rules can be reasoned about (and tested) on their own.
//
// the stack holds parked prompts, newest first. a pop starts a cycle: the text
// that was in the editor becomes a stack entry and the popped entry leaves the
// stack. pressing pop again without editing does not park a second copy; it
// walks the snapshot taken when the cycle started, so the stack is recomputed
// from that fixed snapshot at every step instead of being permuted in place.

export type StashEntryId = number & { readonly __stashEntryId: unique symbol };

export interface StashEntry {
    readonly id: StashEntryId;
    readonly text: string;
    readonly at: number;
}

// where a cycle currently sits: on the text the user had when it started, or on
// one entry of the snapshot.
type CyclePosition = { readonly kind: 'origin' } | { readonly kind: 'entry'; readonly index: number };

interface Cycle {
    // the editor text when the cycle started, already promoted to an entry when
    // it was non-blank (so its id and timestamp stay fixed across the cycle).
    readonly origin: string;
    readonly originEntry: StashEntry | null;
    readonly snapshot: readonly StashEntry[];
    position: CyclePosition;
    // last text this state machine wrote to the editor. a mismatch means the
    // user edited, which ends the cycle.
    shown: string;
}

export type PopResult =
    | { readonly kind: 'empty' }
    | { readonly kind: 'text'; readonly text: string; readonly position: CyclePosition; readonly total: number };

export function isBlank(text: string): boolean {
    return text.trim() === '';
}

export class Stash {
    private entries: StashEntry[] = [];
    private cycle: Cycle | null = null;
    private nextId = 1;
    // the stack as it was before the last drop or clear, so both are reversible
    // without a confirmation prompt. one level, replaced by the next removal.
    private undoState: readonly StashEntry[] | null = null;

    get size(): number {
        return this.entries.length;
    }

    get canUndo(): boolean {
        return this.undoState !== null;
    }

    list(): readonly StashEntry[] {
        return this.entries;
    }

    private entry(text: string): StashEntry {
        return { id: this.nextId++ as StashEntryId, text, at: Date.now() };
    }

    // push the editor text onto the stack. blank text is not stashed.
    push(text: string): boolean {
        if (isBlank(text)) return false;
        this.entries = [this.entry(text), ...this.entries];
        this.cycle = null;
        this.undoState = null;
        return true;
    }

    clear(): number {
        const dropped = this.entries.length;
        if (dropped === 0) return 0;
        this.undoState = this.entries;
        this.entries = [];
        this.cycle = null;
        return dropped;
    }

    drop(id: StashEntryId): boolean {
        const index = this.entries.findIndex((e) => e.id === id);
        if (index < 0) return false;
        this.undoState = this.entries;
        this.entries = this.entries.filter((_, i) => i !== index);
        this.cycle = null;
        return true;
    }

    // put the stack back as it was before the last drop or clear. returns the
    // number of entries restored, or null when there is nothing to undo.
    undo(): number | null {
        if (this.undoState === null) return null;
        const restored = this.undoState.length - this.entries.length;
        this.entries = [...this.undoState];
        this.undoState = null;
        this.cycle = null;
        return restored;
    }

    // pop, or advance an in-progress cycle when the editor still holds exactly
    // what the last pop put there.
    pop(editorText: string): PopResult {
        const active = this.cycle !== null && this.cycle.shown === editorText ? this.cycle : null;
        if (active) {
            return this.settle(active, advance(active.position, active.snapshot.length));
        }
        if (this.entries.length === 0) return { kind: 'empty' };
        return this.settle(this.begin(editorText), { kind: 'entry', index: 0 });
    }

    // take a specific entry, as chosen in the picker, and continue cycling from
    // there on the next pop.
    take(id: StashEntryId, editorText: string): PopResult {
        const active = this.cycle !== null && this.cycle.shown === editorText ? this.cycle : null;
        const cycle = active ?? this.begin(editorText);
        const index = cycle.snapshot.findIndex((e) => e.id === id);
        if (index < 0) return { kind: 'empty' };
        return this.settle(cycle, { kind: 'entry', index });
    }

    private begin(editorText: string): Cycle {
        const originEntry = isBlank(editorText) ? null : this.entry(editorText);
        const cycle: Cycle = {
            origin: editorText,
            originEntry,
            snapshot: [...this.entries],
            position: { kind: 'origin' },
            shown: editorText,
        };
        this.cycle = cycle;
        return cycle;
    }

    // rebuild the stack from the snapshot for the given position, so repeated
    // pops never accumulate copies or reorder anything.
    private settle(cycle: Cycle, position: CyclePosition): PopResult {
        // any other change to the stack retires the undo, so an undo can never
        // resurrect a stack that no longer matches what the user last saw.
        this.undoState = null;
        cycle.position = position;
        if (position.kind === 'origin') {
            this.entries = [...cycle.snapshot];
            cycle.shown = cycle.origin;
            return { kind: 'text', text: cycle.origin, position, total: cycle.snapshot.length };
        }
        const shown = cycle.snapshot[position.index];
        if (!shown) return { kind: 'empty' };
        const rest = cycle.snapshot.filter((_, i) => i !== position.index);
        this.entries = cycle.originEntry ? [cycle.originEntry, ...rest] : rest;
        cycle.shown = shown.text;
        return { kind: 'text', text: shown.text, position, total: cycle.snapshot.length };
    }
}

// entry 0 .. entry n-1, then the text the cycle started from, then round again.
function advance(position: CyclePosition, total: number): CyclePosition {
    if (position.kind === 'origin') return total > 0 ? { kind: 'entry', index: 0 } : { kind: 'origin' };
    const next = position.index + 1;
    return next < total ? { kind: 'entry', index: next } : { kind: 'origin' };
}
