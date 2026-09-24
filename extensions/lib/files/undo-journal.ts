// what the agent did to a file, and the bytes it did it to.
//
// pi-rewind keeps one commit per prompt: `producer.turnStart` on the first
// assistant message and `turnEnd` at the end of the turn, restored with
// `git reset --hard` plus `git clean -fd` over the whole work tree. that is the
// right unit for running a prompt again and the wrong one for taking back a
// single write: the reset carries away everything else that happened in the
// window, including edits the person made while the turn was running, and it
// exists only inside a git work tree.
//
// this is the other unit. one record per mutation, holding the path, the bytes
// before, and enough of the state after to tell whether anything has touched
// the file since. undo restores one record, on the machine the file is on, and
// refuses when the file no longer matches what the mutation left, because
// putting the old bytes back over somebody else's newer ones is the same
// accident one level down.
//
// the bytes are never held in this process. a backup is a copy made where the
// file is (see file-store.ts), so a 40 MB file on a rented node costs one `cp`
// there and nothing on the wire.

import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FileStore, Stat } from './file-store';
import { PersistedState, type StateIdentity } from '../core/state-store';

/** the tools that change a file's bytes and are journalled. */
export type MutatingTool = 'write' | 'edit' | 'remove';

/** what was kept of the file as it was before the mutation. */
export type Recorded =
    | { readonly kind: 'absent' }
    | { readonly kind: 'saved'; readonly backup: string; readonly bytes: number; readonly digest: string | null }
    | { readonly kind: 'directory'; readonly backup: string }
    /** nothing was kept, and why. an undo of this record can only refuse. */
    | { readonly kind: 'unsaved'; readonly why: 'too-large' | 'unreadable'; readonly bytes: number };

/** what the file looked like once the mutation had finished. */
export type Seen =
    | { readonly kind: 'absent' }
    | { readonly kind: 'file'; readonly digest: string | null; readonly bytes: number }
    | { readonly kind: 'directory' };

export interface UndoEntry {
    readonly id: number;
    /** ISO 8601, in the session's own clock. */
    readonly at: string;
    readonly tool: MutatingTool;
    /** 'local', or the name of the environment the file is on. */
    readonly machine: string;
    /** absolute, on that machine. */
    readonly path: string;
    readonly before: Recorded;
    readonly after: Seen;
    /** where the trash put it, when the trash command named the destination. */
    readonly trashed: string | null;
}

interface Journalled {
    readonly version: 1;
    readonly next: number;
    readonly entries: readonly UndoEntry[];
}

/** limits that keep the journal from copying a repository aside by accident. */
export interface Limits {
    readonly maxEntries: number;
    readonly maxBytes: number;
}

const isRecorded = (raw: unknown): raw is Recorded => {
    if (typeof raw !== 'object' || raw === null) return false;
    const kind = (raw as { kind?: unknown }).kind;
    return kind === 'absent' || kind === 'saved' || kind === 'directory' || kind === 'unsaved';
};

const isSeen = (raw: unknown): raw is Seen => {
    if (typeof raw !== 'object' || raw === null) return false;
    const kind = (raw as { kind?: unknown }).kind;
    return kind === 'absent' || kind === 'file' || kind === 'directory';
};

const isEntry = (raw: unknown): raw is UndoEntry => {
    if (typeof raw !== 'object' || raw === null) return false;
    const value = raw as Record<string, unknown>;
    return (
        typeof value.id === 'number'
        && typeof value.at === 'string'
        && (value.tool === 'write' || value.tool === 'edit' || value.tool === 'remove')
        && typeof value.machine === 'string'
        && typeof value.path === 'string'
        && isRecorded(value.before)
        && isSeen(value.after)
        && (value.trashed === null || typeof value.trashed === 'string')
    );
};

const parse = (raw: unknown): Journalled | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const value = raw as Record<string, unknown>;
    if (value.version !== 1 || typeof value.next !== 'number' || !Array.isArray(value.entries)) return null;
    return { version: 1, next: value.next, entries: value.entries.filter(isEntry) };
};

/** an entry as it is offered before it has an identity. */
export type Proposed = Omit<UndoEntry, 'id' | 'at'>;

/**
 * the session's journal: a stack of mutations, newest last, on disk so that a
 * resumed session can still take back what the previous run did.
 */
export class Journal {
    private constructor(
        private readonly state: PersistedState<Journalled>,
        private readonly limits: Limits,
    ) {}

    static open(identity: StateIdentity, limits: Limits): Journal {
        return new Journal(
            PersistedState.open<Journalled>({ name: 'undo', scope: 'session', parse }, identity),
            limits,
        );
    }

    private load(): Journalled {
        return this.state.read() ?? { version: 1, next: 1, entries: [] };
    }

    entries(): readonly UndoEntry[] {
        return this.load().entries;
    }

    /**
     * append one mutation. the entries pushed off the end are returned rather
     * than dropped quietly, since each one owns a backup the caller has to
     * delete.
     */
    record(proposed: Proposed): { readonly entry: UndoEntry; readonly evicted: readonly UndoEntry[] } {
        const held = this.load();
        const entry: UndoEntry = { ...proposed, id: held.next, at: new Date().toISOString() };
        const all = [...held.entries, entry];
        const keep = all.slice(Math.max(0, all.length - this.limits.maxEntries));
        const evicted = all.slice(0, all.length - keep.length);
        this.state.write({ version: 1, next: held.next + 1, entries: keep });
        return { entry, evicted };
    }

    /** take an entry out of the stack, once it has been undone. */
    forget(id: number): void {
        const held = this.load();
        this.state.write({ version: 1, next: held.next, entries: held.entries.filter((entry) => entry.id !== id) });
    }
}

/**
 * one journal per session, shared by every extension that mutates a file.
 *
 * the write guard, the remove tool and the undo tool are three extensions and
 * one stack: a remove the guard sent them to has to be undoable by the tool in
 * the third file.
 */
let held: { readonly session: string; readonly journal: Journal } | null = null;

export function sessionJournal(identity: StateIdentity, limits: Limits): Journal {
    const session = identity.sessionId ?? 'none';
    if (held !== null && held.session === session) return held.journal;
    const journal = Journal.open(identity, limits);
    held = { session, journal };
    return journal;
}

/**
 * where one mutation's copy goes: its own directory, so two mutations of the
 * same path never write over each other's backup.
 */
export function slotFor(root: string, path: string): string {
    return join(root, randomUUID().slice(0, 8), basename(path) === '' ? 'root' : basename(path));
}

/** drop backup directories left by sessions that ended long ago. */
export function pruneBackups(root: string, days: number): void {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let sessions: string[];
    try {
        sessions = readdirSync(root);
    } catch {
        return;
    }
    for (const session of sessions) {
        const full = join(root, session);
        try {
            if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
        } catch {
            // raced with another session pruning the same directory.
        }
    }
}

/**
 * the entries an undo would act on: newest first, one path when asked for, and
 * never more than were asked for.
 *
 * an id names one mutation exactly and overrides the rest, since it is the
 * number the record was reported under when it was made ('undo 4 puts it back')
 * and the number `list` prints. nothing else in the journal is stable enough to
 * name one call: a path can have been written five times, and 'the last one'
 * moves every time another tool runs.
 */
export function pick(
    entries: readonly UndoEntry[],
    request: { readonly id?: number; readonly path?: string; readonly count: number },
): readonly UndoEntry[] {
    if (request.id !== undefined) return entries.filter((entry) => entry.id === request.id);
    const newestFirst = [...entries].reverse();
    const matching = request.path === undefined ? newestFirst : newestFirst.filter((e) => e.path === request.path);
    return matching.slice(0, Math.max(1, request.count));
}

/** whether the file still holds what the mutation left there. */
export function unchanged(after: Seen, now: Stat, digest: string | null): boolean {
    switch (after.kind) {
        case 'absent':
            return now.kind === 'absent';
        case 'directory':
            return now.kind === 'directory';
        case 'file':
            if (now.kind !== 'file') return false;
            // the digest is what decides; the size is the answer when the
            // machine could not produce one (no sha256sum, no shasum).
            if (after.digest !== null && digest !== null) return after.digest === digest;
            return after.bytes === now.bytes;
    }
}

/** how the file now differs from what the mutation left, in one clause. */
export function difference(after: Seen, now: Stat): string {
    if (now.kind === 'absent') return 'it no longer exists';
    if (now.kind === 'directory') return 'it is now a directory';
    if (after.kind === 'absent') return 'it exists again';
    if (after.kind === 'directory') return 'it is no longer a directory';
    return `its contents changed (${after.bytes} bytes then, ${now.bytes} now)`;
}

export type Reverted =
    | { readonly kind: 'restored'; readonly from: 'backup' | 'trash' | 'deletion' }
    | { readonly kind: 'changed'; readonly detail: string }
    | { readonly kind: 'unrecoverable'; readonly detail: string }
    | { readonly kind: 'failed'; readonly detail: string };

/**
 * put one mutation back.
 *
 * the state after the mutation is checked first. an undo that overwrote newer
 * bytes would be the same accident the journal exists to take back, so a file
 * that moved on since is reported and left alone.
 */
export async function revert(store: FileStore, entry: UndoEntry): Promise<Reverted> {
    const now = await store.stat(entry.path);
    const digest = now.kind === 'file' ? await store.digest(entry.path) : null;
    if (!unchanged(entry.after, now, digest)) {
        return { kind: 'changed', detail: difference(entry.after, now) };
    }

    const before = entry.before;
    if (before.kind === 'unsaved') {
        if (entry.trashed === null) {
            const why = before.why === 'too-large'
                ? `it was ${before.bytes} bytes, over the undo size limit, so nothing was kept`
                : 'its contents could not be read when the mutation happened';
            return { kind: 'unrecoverable', detail: why };
        }
    }

    try {
        if (before.kind === 'absent') {
            await store.delete(entry.path);
            return { kind: 'restored', from: 'deletion' };
        }
        // a removed file is moved back out of the trash where the trash named
        // its destination, so the trash is left as it was rather than holding
        // a copy of a file that is once again in the work tree.
        if (entry.trashed !== null && (await store.stat(entry.trashed)).kind !== 'absent') {
            await store.move(entry.trashed, entry.path);
            return { kind: 'restored', from: 'trash' };
        }
        if (before.kind === 'unsaved') {
            return { kind: 'unrecoverable', detail: 'the copy in the trash is gone and nothing else was kept' };
        }
        await store.copy(before.backup, entry.path);
        return { kind: 'restored', from: 'backup' };
    } catch (error) {
        return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * copy a path aside, giving the record of what was there.
 *
 * `slot` is the entry's own directory under the backup root, so two mutations
 * of the same path never share a copy.
 */
export async function keep(
    store: FileStore,
    path: string,
    slot: string,
    limits: Limits,
): Promise<Recorded> {
    const now = await store.stat(path);
    if (now.kind === 'absent') return { kind: 'absent' };
    if (now.kind === 'file' && now.bytes > limits.maxBytes) {
        return { kind: 'unsaved', why: 'too-large', bytes: now.bytes };
    }
    try {
        await store.copy(path, slot);
    } catch {
        return { kind: 'unsaved', why: 'unreadable', bytes: now.kind === 'file' ? now.bytes : 0 };
    }
    if (now.kind === 'directory') return { kind: 'directory', backup: slot };
    return { kind: 'saved', backup: slot, bytes: now.bytes, digest: await store.digest(path) };
}

/** what a path looks like once a mutation has finished with it. */
export async function look(store: FileStore, path: string): Promise<Seen> {
    const now = await store.stat(path);
    if (now.kind === 'absent') return { kind: 'absent' };
    if (now.kind === 'directory') return { kind: 'directory' };
    return { kind: 'file', digest: await store.digest(path), bytes: now.bytes };
}

/**
 * record a mutation and clear away what the record pushed off the end.
 *
 * an evicted entry owns a copy on some machine; the ones on the machine in
 * hand are deleted here, and the rest go when that machine's backup root is
 * pruned or when the machine itself ends.
 */
export async function recordMutation(
    journal: Journal,
    store: FileStore,
    proposed: Proposed,
): Promise<UndoEntry> {
    const { entry, evicted } = journal.record(proposed);
    for (const old of evicted) {
        if (old.machine !== store.machine) continue;
        const backup = old.before.kind === 'saved' || old.before.kind === 'directory' ? old.before.backup : null;
        if (backup === null) continue;
        try {
            await store.delete(dirname(backup));
        } catch {
            // a copy that will not delete is a stale directory, not a failure
            // of the mutation being recorded.
        }
    }
    return entry;
}

/** one line per entry, newest first, as the `undo` tool lists them. */
export function describe(entry: UndoEntry): string {
    const where = entry.machine === 'local' ? '' : ` on ${entry.machine}`;
    const kept = entry.before.kind === 'saved'
        ? `${entry.before.bytes} bytes kept`
        : entry.before.kind === 'absent'
          ? 'it did not exist before'
          : entry.before.kind === 'directory'
            ? 'directory kept'
            : `nothing kept (${entry.before.why})`;
    return `${entry.id}. ${entry.tool} ${entry.path}${where}: ${kept}, at ${entry.at}`;
}
