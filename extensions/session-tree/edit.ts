// the edit buffer behind extensions/session-tree.ts: a session's entry list,
// a log of edits over it, and the tree surgery each edit implies. no pi
// imports beyond the entry types and no UI, so the rules below are testable on
// their own.
//
// nothing here writes to disk. the buffer holds the entries as loaded, the ops
// applied to them, and recomputes the edited list from the base on every
// change, so undo is dropping the last op rather than an inverse operation.
//
// three constraints the surgery has to respect, all of them things a session
// file can express and an edited one must not break:
//
//   parents      every surviving entry's parentId names a surviving entry or
//                null. removing an entry either takes its descendants with it
//                or re-chains them onto the nearest survivor above.
//   units        an assistant message carrying tool calls and the toolResult
//                entries answering them are one unit. a provider rejects a
//                tool call with no result and a result with no call, so a
//                selection endpoint landing inside the pair is pushed out to
//                cover it.
//   references   a label names its target, a compaction names its first kept
//                entry, a branch summary names where it branched from. a
//                reference to a removed entry is retargeted upward, or the
//                referring entry goes too.
//
// a run is a contiguous span of one root-to-leaf path, named by its endpoints.
// selection is confined to a path because the tree's other shape, a span
// crossing a branch point into a sibling, is not something delete or summarise
// has a meaning for.

import type { SessionEntry, SessionTreeNode } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';

export type EntryId = string;

/** a contiguous span of one path, top nearest the root. */
export interface Run {
    readonly top: EntryId;
    readonly bottom: EntryId;
}

export type DeleteMode = 'rechain' | 'subtree';

export type Op =
    | { readonly kind: 'delete'; readonly run: Run; readonly mode: DeleteMode }
    | { readonly kind: 'summarize'; readonly run: Run; readonly summary: string }
    | { readonly kind: 'prune'; readonly to: EntryId }
    | { readonly kind: 'edit'; readonly id: EntryId; readonly text: string };

/** customType on the entry a summarised run collapses to. */
export const SUMMARY_TYPE = 'rho-summary';

interface Index {
    readonly byId: ReadonlyMap<EntryId, SessionEntry>;
    readonly children: ReadonlyMap<EntryId | null, readonly EntryId[]>;
}

function index(entries: readonly SessionEntry[]): Index {
    const byId = new Map<EntryId, SessionEntry>();
    const children = new Map<EntryId | null, EntryId[]>();
    for (const entry of entries) {
        byId.set(entry.id, entry);
        const siblings = children.get(entry.parentId);
        if (siblings) siblings.push(entry.id);
        else children.set(entry.parentId, [entry.id]);
    }
    return { byId, children };
}

/**
 * the tree an entry list makes, in the shape pi's tree view takes.
 *
 * this is SessionManager.getTree() over entries the manager does not hold: the
 * edit buffer's tree is not on disk, so the view has to be built from it. the
 * rules are pi's own, including sorting siblings by timestamp and treating an
 * orphan as a root.
 */
export function treeOf(entries: readonly SessionEntry[]): SessionTreeNode[] {
    const labels = new Map<EntryId, { label: string | undefined; at: string }>();
    for (const entry of entries) {
        if (entry.type === 'label') labels.set(entry.targetId, { label: entry.label, at: entry.timestamp });
    }

    const nodes = new Map<EntryId, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of entries) {
        const resolved = labels.get(entry.id);
        nodes.set(entry.id, {
            entry,
            children: [],
            ...(resolved?.label !== undefined && { label: resolved.label, labelTimestamp: resolved.at }),
        });
    }
    for (const entry of entries) {
        const node = nodes.get(entry.id)!;
        const parent = entry.parentId === null || entry.parentId === entry.id ? undefined : nodes.get(entry.parentId);
        if (parent) parent.children.push(node);
        else roots.push(node);
    }
    const stack = [...roots];
    while (stack.length > 0) {
        const node = stack.pop()!;
        node.children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
        stack.push(...node.children);
    }
    return roots;
}

/** ids from the root down to `leaf`, inclusive. empty when `leaf` is unknown. */
export function pathTo(entries: readonly SessionEntry[], leaf: EntryId): readonly EntryId[] {
    const { byId } = index(entries);
    const path: EntryId[] = [];
    const seen = new Set<EntryId>();
    let at: EntryId | null = leaf;
    while (at !== null) {
        const entry = byId.get(at);
        if (!entry || seen.has(at)) return [];
        seen.add(at);
        path.push(at);
        at = entry.parentId;
    }
    return path.reverse();
}

/** the deepest leaf below `from`, following the first child at each branch. */
export function leafBelow(entries: readonly SessionEntry[], from: EntryId): EntryId {
    const { children } = index(entries);
    let at = from;
    for (;;) {
        const next = children.get(at);
        if (!next || next.length === 0) return at;
        at = next[0]!;
    }
}

function assistantCalls(entry: SessionEntry): readonly ToolCall[] {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') return [];
    const message = entry.message as AssistantMessage;
    return message.content.filter((part): part is ToolCall => part.type === 'toolCall');
}

function resultCallId(entry: SessionEntry): string | undefined {
    if (entry.type !== 'message' || entry.message.role !== 'toolResult') return undefined;
    return (entry.message as ToolResultMessage).toolCallId;
}

/**
 * the run covering the tool-call unit `id` belongs to, along `path`.
 *
 * an assistant message that made calls extends down over the results answering
 * them; a result extends up to its assistant and down over its siblings.
 * everything else is its own unit.
 */
export function unitRun(entries: readonly SessionEntry[], path: readonly EntryId[], id: EntryId): Run {
    const { byId } = index(entries);
    const at = path.indexOf(id);
    if (at < 0) return { top: id, bottom: id };

    let top = at;
    const entryAt = (position: number): SessionEntry | undefined => byId.get(path[position]!);
    while (top > 0 && resultCallId(entryAt(top)!) !== undefined) top -= 1;

    const pending = new Set(assistantCalls(entryAt(top)!).map((call) => call.id));
    if (pending.size === 0) return { top: id, bottom: id };

    let bottom = top;
    for (let position = top + 1; position < path.length && pending.size > 0; position += 1) {
        const callId = resultCallId(entryAt(position)!);
        if (callId === undefined || !pending.has(callId)) break;
        pending.delete(callId);
        bottom = position;
    }
    if (bottom < at) return { top: id, bottom: id };
    return { top: path[top]!, bottom: path[bottom]! };
}

/**
 * the run spanned by two endpoints on `path`, ordered and widened so neither
 * end cuts a tool-call unit in half.
 */
export function snapRun(entries: readonly SessionEntry[], path: readonly EntryId[], a: EntryId, b: EntryId): Run {
    const first = path.indexOf(a);
    const second = path.indexOf(b);
    if (first < 0 || second < 0) return { top: a, bottom: a };
    let top = Math.min(first, second);
    let bottom = Math.max(first, second);
    for (;;) {
        const widenedTop = path.indexOf(unitRun(entries, path, path[top]!).top);
        const widenedBottom = path.indexOf(unitRun(entries, path, path[bottom]!).bottom);
        if (widenedTop >= top && widenedBottom <= bottom) break;
        top = Math.min(top, widenedTop);
        bottom = Math.max(bottom, widenedBottom);
    }
    return { top: path[top]!, bottom: path[bottom]! };
}

/**
 * the run two entries span, or undefined when neither is an ancestor of the
 * other. selection keys move along a lineage and cannot produce that second
 * case, but a jump by search or by label can, and a span crossing a branch
 * point is not something delete or summarise has a meaning for.
 */
export function runBetween(entries: readonly SessionEntry[], a: EntryId, b: EntryId): Run | undefined {
    for (const [deep, shallow] of [
        [a, b],
        [b, a],
    ] as const) {
        const path = pathTo(entries, deep);
        if (path.includes(shallow)) return snapRun(entries, path, shallow, deep);
    }
    return undefined;
}

/** the ids of a run, top first. empty when the run is not a path span. */
export function runIds(entries: readonly SessionEntry[], run: Run): readonly EntryId[] {
    const path = pathTo(entries, run.bottom);
    const top = path.indexOf(run.top);
    if (top < 0) return [];
    return path.slice(top);
}

function descendantsOf(entries: readonly SessionEntry[], roots: Iterable<EntryId>): Set<EntryId> {
    const { children } = index(entries);
    const out = new Set<EntryId>();
    const queue = [...roots];
    while (queue.length > 0) {
        const at = queue.pop()!;
        for (const child of children.get(at) ?? []) {
            if (out.has(child)) continue;
            out.add(child);
            queue.push(child);
        }
    }
    return out;
}

/**
 * remove `removed` from the tree.
 *
 * survivors whose parent went are re-chained onto the nearest surviving
 * ancestor, which is what keeps a branch hanging off the middle of a deleted
 * run attached rather than orphaned. callers wanting the descendants gone pass
 * them in `removed` instead. `reattach` overrides the destination, for the
 * case where a replacement entry stands in the removed span's place.
 */
export function removeEntries(
    entries: readonly SessionEntry[],
    removed: ReadonlySet<EntryId>,
    reattach?: EntryId,
): readonly SessionEntry[] {
    if (removed.size === 0) return entries;
    const { byId } = index(entries);

    // a label whose target went is removed too, and it is a tree entry, so it
    // has to join the removed set before anything is re-chained: a survivor
    // parented to a dropped label would otherwise keep pointing at it.
    const gone = new Set(removed);
    for (const entry of entries) {
        if (entry.type === 'label' && gone.has(entry.targetId)) gone.add(entry.id);
    }

    const survivingAncestor = (from: EntryId | null): EntryId | null => {
        let at = from;
        const seen = new Set<EntryId>();
        while (at !== null && gone.has(at)) {
            if (seen.has(at)) return null;
            seen.add(at);
            at = byId.get(at)?.parentId ?? null;
        }
        return at;
    };

    const out: SessionEntry[] = [];
    for (const entry of entries) {
        if (gone.has(entry.id)) continue;
        const parentId =
            reattach !== undefined && entry.parentId !== null && gone.has(entry.parentId)
                ? reattach
                : survivingAncestor(entry.parentId);
        let next: SessionEntry = parentId === entry.parentId ? entry : { ...entry, parentId };
        if (next.type === 'compaction' && gone.has(next.firstKeptEntryId)) {
            // firstKeptEntryId names an ancestor of the compaction; the nearest
            // surviving one keeps the kept range as wide as it was, never wider.
            const retargeted = survivingAncestor(next.firstKeptEntryId);
            next = { ...next, firstKeptEntryId: retargeted ?? next.id };
        }
        if (next.type === 'branch_summary' && gone.has(next.fromId)) {
            next = { ...next, fromId: survivingAncestor(next.fromId) ?? next.id };
        }
        out.push(next);
    }
    return out;
}

/** delete a run, either re-chaining what hung off it or taking that with it. */
export function deleteRun(entries: readonly SessionEntry[], run: Run, mode: DeleteMode): readonly SessionEntry[] {
    const ids = runIds(entries, run);
    if (ids.length === 0) return entries;
    const removed = new Set(ids);
    if (mode === 'subtree') for (const id of descendantsOf(entries, ids)) removed.add(id);
    return removeEntries(entries, removed);
}

/** the id a synthesised entry takes: pi's own 8 hex characters. */
function newEntryId(taken: ReadonlySet<EntryId>): EntryId {
    for (;;) {
        const id = Math.floor(Math.random() * 0x1_0000_0000)
            .toString(16)
            .padStart(8, '0');
        if (!taken.has(id)) return id;
    }
}

/**
 * replace a run with one entry holding `summary`.
 *
 * the summary is a custom_message: it participates in context, which a custom
 * entry does not, and it stays clear of the bookkeeping pi's own compaction
 * entries carry.
 */
export function summarizeRun(entries: readonly SessionEntry[], run: Run, summary: string): readonly SessionEntry[] {
    const ids = runIds(entries, run);
    if (ids.length === 0) return entries;
    const { byId } = index(entries);
    const top = byId.get(run.top);
    if (!top) return entries;

    const id = newEntryId(new Set(entries.map((entry) => entry.id)));
    const replacement: SessionEntry = {
        type: 'custom_message',
        id,
        parentId: top.parentId,
        timestamp: new Date().toISOString(),
        customType: SUMMARY_TYPE,
        content: summary,
        display: true,
        details: { replaced: ids.length, from: run.top, to: run.bottom },
    };

    // the replacement stands where the run's top stood, so anything that hung
    // off the removed span lands under it rather than under the run's parent.
    const out = [...removeEntries(entries, new Set(ids), id)];
    const at = entries.findIndex((entry) => entry.id === run.top);
    out.splice(Math.min(Math.max(at, 0), out.length), 0, replacement);
    return out;
}

/** keep the path from the root down to `to`, and drop every other branch. */
export function pruneToLineage(entries: readonly SessionEntry[], to: EntryId): readonly SessionEntry[] {
    const keep = new Set(pathTo(entries, to));
    if (keep.size === 0) return entries;
    const removed = new Set<EntryId>();
    for (const entry of entries) {
        if (keep.has(entry.id)) continue;
        // a label on a kept entry is part of that path's state, wherever it
        // sits in the chain, so it is re-chained rather than dropped.
        if (entry.type === 'label' && keep.has(entry.targetId)) continue;
        removed.add(entry.id);
    }
    return removeEntries(entries, removed);
}

function editedMessage(entry: SessionEntry, text: string): SessionEntry {
    if (entry.type === 'custom_message') return { ...entry, content: text };
    if (entry.type !== 'message') return entry;
    const message = entry.message;
    if (message.role === 'user' || message.role === 'custom') {
        return { ...entry, message: { ...message, content: [{ type: 'text', text }] } };
    }
    if (message.role === 'assistant') {
        // only the prose is editable: the tool calls are answered by entries
        // below this one, so replacing them would strand those results.
        const kept = message.content.filter((part) => part.type !== 'text');
        const content = [{ type: 'text', text } as TextContent, ...kept];
        return { ...entry, message: { ...message, content } };
    }
    return entry;
}

/** whether an entry's text can be replaced at all. */
export function isEditable(entry: SessionEntry): boolean {
    if (entry.type === 'custom_message') return true;
    if (entry.type !== 'message') return false;
    return entry.message.role === 'user' || entry.message.role === 'assistant' || entry.message.role === 'custom';
}

/** the text an edit starts from. */
export function editableText(entry: SessionEntry): string {
    if (entry.type === 'custom_message') {
        return typeof entry.content === 'string'
            ? entry.content
            : entry.content
                  .filter((part): part is TextContent => part.type === 'text')
                  .map((part) => part.text)
                  .join('\n');
    }
    if (entry.type !== 'message') return '';
    const message = entry.message;
    if (message.role === 'user' || message.role === 'custom') {
        return typeof message.content === 'string'
            ? message.content
            : message.content
                  .filter((part): part is TextContent => part.type === 'text')
                  .map((part) => part.text)
                  .join('\n');
    }
    if (message.role === 'assistant') {
        return message.content
            .filter((part): part is TextContent => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
    }
    return '';
}

export function applyOp(entries: readonly SessionEntry[], op: Op): readonly SessionEntry[] {
    switch (op.kind) {
        case 'delete':
            return deleteRun(entries, op.run, op.mode);
        case 'summarize':
            return summarizeRun(entries, op.run, op.summary);
        case 'prune':
            return pruneToLineage(entries, op.to);
        case 'edit': {
            const at = entries.findIndex((entry) => entry.id === op.id);
            if (at < 0) return entries;
            const out = [...entries];
            out[at] = editedMessage(entries[at]!, op.text);
            return out;
        }
    }
}

/**
 * the entries as loaded, the ops over them, and the edited result.
 *
 * the result is recomputed from the base on every change: an op is a function
 * of the tree it is applied to, so replaying the log is both the redo and the
 * definition of what the log means. undo drops the last op.
 */
export class EditBuffer {
    private readonly base: readonly SessionEntry[];
    private readonly log: Op[] = [];
    private current: readonly SessionEntry[];

    constructor(base: readonly SessionEntry[]) {
        this.base = base;
        this.current = base;
    }

    get entries(): readonly SessionEntry[] {
        return this.current;
    }

    get ops(): readonly Op[] {
        return this.log;
    }

    get dirty(): boolean {
        return this.log.length > 0;
    }

    apply(op: Op): void {
        this.log.push(op);
        this.current = applyOp(this.current, op);
    }

    undo(): Op | undefined {
        const op = this.log.pop();
        if (!op) return undefined;
        this.current = this.log.reduce<readonly SessionEntry[]>((entries, next) => applyOp(entries, next), this.base);
        return op;
    }

    reset(): void {
        this.log.length = 0;
        this.current = this.base;
    }

    /** whether `id` still exists after the edits applied so far. */
    has(id: EntryId): boolean {
        return this.current.some((entry) => entry.id === id);
    }
}
