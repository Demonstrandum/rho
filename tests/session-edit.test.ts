import { test, expect } from 'bun:test';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
    EditBuffer,
    SUMMARY_TYPE,
    deleteRun,
    editableText,
    isEditable,
    leafBelow,
    pathTo,
    pruneToLineage,
    runIds,
    snapRun,
    summarizeRun,
    unitRun,
    runBetween,
    treeOf,
    applyOp,
} from '../extensions/session-tree/edit';

const at = '2026-01-01T00:00:00.000Z';

function user(id: string, parentId: string | null, text: string): SessionEntry {
    return {
        type: 'message',
        id,
        parentId,
        timestamp: at,
        message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
    };
}

function assistant(id: string, parentId: string | null, text: string, calls: string[] = []): SessionEntry {
    return {
        type: 'message',
        id,
        parentId,
        timestamp: at,
        message: {
            role: 'assistant',
            content: [
                { type: 'text', text },
                ...calls.map((callId) => ({ type: 'toolCall' as const, id: callId, name: 'bash', arguments: {} })),
            ],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'claude',
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            timestamp: 0,
        },
    } as SessionEntry;
}

function result(id: string, parentId: string, callId: string): SessionEntry {
    return {
        type: 'message',
        id,
        parentId,
        timestamp: at,
        message: {
            role: 'toolResult',
            toolCallId: callId,
            toolName: 'bash',
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
            timestamp: 0,
        },
    } as SessionEntry;
}

function label(id: string, parentId: string, targetId: string, text: string): SessionEntry {
    return { type: 'label', id, parentId, timestamp: at, targetId, label: text };
}

/**
 * u1 - a1 - u2 - a2(calls c1) - r1 - u3 - a3
 *                                 \- u4 - a4   (a second branch off r1)
 */
function tree(): SessionEntry[] {
    return [
        user('u1', null, 'one'),
        assistant('a1', 'u1', 'first'),
        user('u2', 'a1', 'two'),
        assistant('a2', 'u2', 'second', ['c1']),
        result('r1', 'a2', 'c1'),
        user('u3', 'r1', 'three'),
        assistant('a3', 'u3', 'third'),
        user('u4', 'r1', 'four'),
        assistant('a4', 'u4', 'fourth'),
    ];
}

test('a path runs from the root to the named entry', () => {
    expect(pathTo(tree(), 'a3')).toEqual(['u1', 'a1', 'u2', 'a2', 'r1', 'u3', 'a3']);
    expect(pathTo(tree(), 'nope')).toEqual([]);
});

test('the leaf below a branch point follows the first child', () => {
    expect(leafBelow(tree(), 'r1')).toBe('a3');
    expect(leafBelow(tree(), 'a4')).toBe('a4');
});

test('an endpoint inside a tool-call pair widens to cover it', () => {
    const entries = tree();
    const path = pathTo(entries, 'a3');
    expect(unitRun(entries, path, 'a2')).toEqual({ top: 'a2', bottom: 'r1' });
    expect(unitRun(entries, path, 'r1')).toEqual({ top: 'a2', bottom: 'r1' });
    expect(unitRun(entries, path, 'u2')).toEqual({ top: 'u2', bottom: 'u2' });
    expect(snapRun(entries, path, 'r1', 'u3')).toEqual({ top: 'a2', bottom: 'u3' });
    expect(snapRun(entries, path, 'u3', 'a2')).toEqual({ top: 'a2', bottom: 'u3' });
});

test('a run is listed top first', () => {
    expect(runIds(tree(), { top: 'u2', bottom: 'r1' })).toEqual(['u2', 'a2', 'r1']);
    expect(runIds(tree(), { top: 'u4', bottom: 'a3' })).toEqual([]);
});

test('deleting a run re-chains what hung off it, including the other branch', () => {
    const out = deleteRun(tree(), { top: 'u2', bottom: 'r1' }, 'rechain');
    expect(out.map((entry) => entry.id)).toEqual(['u1', 'a1', 'u3', 'a3', 'u4', 'a4']);
    expect(out.find((entry) => entry.id === 'u3')?.parentId).toBe('a1');
    expect(out.find((entry) => entry.id === 'u4')?.parentId).toBe('a1');
});

test('deleting a subtree takes the descendants of both branches', () => {
    const out = deleteRun(tree(), { top: 'u2', bottom: 'r1' }, 'subtree');
    expect(out.map((entry) => entry.id)).toEqual(['u1', 'a1']);
});

test('deleting the root leaves the survivors parentless', () => {
    const out = deleteRun(tree(), { top: 'u1', bottom: 'a1' }, 'rechain');
    expect(out.find((entry) => entry.id === 'u2')?.parentId).toBeNull();
});

test('a label on a deleted entry goes, one on a survivor is kept and re-chained', () => {
    const entries = [...tree(), label('l1', 'a4', 'u2', 'gone'), label('l2', 'l1', 'u1', 'kept')];
    const out = deleteRun(entries, { top: 'u2', bottom: 'u2' }, 'rechain');
    expect(out.find((entry) => entry.id === 'l1')).toBeUndefined();
    expect(out.find((entry) => entry.id === 'l2')?.parentId).toBe('a4');
});

test('a compaction whose first kept entry is deleted retargets upward', () => {
    const entries: SessionEntry[] = [
        ...tree(),
        {
            type: 'compaction',
            id: 'k1',
            parentId: 'a3',
            timestamp: at,
            summary: 's',
            firstKeptEntryId: 'u2',
            tokensBefore: 10,
        },
    ];
    const out = deleteRun(entries, { top: 'u2', bottom: 'r1' }, 'rechain');
    const compaction = out.find((entry) => entry.id === 'k1');
    expect(compaction?.type === 'compaction' && compaction.firstKeptEntryId).toBe('a1');
});

test('summarising a run puts one entry in its place and adopts its children', () => {
    const out = summarizeRun(tree(), { top: 'u2', bottom: 'r1' }, 'what happened');
    const summary = out.find((entry) => entry.type === 'custom_message');
    expect(summary?.type === 'custom_message' && summary.customType).toBe(SUMMARY_TYPE);
    expect(summary?.type === 'custom_message' && summary.content).toBe('what happened');
    expect(summary?.parentId).toBe('a1');
    expect(out.find((entry) => entry.id === 'u3')?.parentId).toBe(summary?.id);
    expect(out.find((entry) => entry.id === 'u4')?.parentId).toBe(summary?.id);
    expect(out.map((entry) => entry.id).indexOf(summary!.id)).toBe(2);
});

test('pruning keeps the lineage and drops the other branch', () => {
    const out = pruneToLineage(tree(), 'u3');
    expect(out.map((entry) => entry.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'r1', 'u3']);
});

test('editing replaces user text and keeps an assistant message tool calls', () => {
    const entries = tree();
    const edited = applyOp(entries, { kind: 'edit', id: 'a2', text: 'rewritten' });
    const entry = edited.find((item) => item.id === 'a2');
    expect(entry?.type === 'message' && editableText(entry)).toBe('rewritten');
    expect(
        entry?.type === 'message' && entry.message.role === 'assistant'
            ? entry.message.content.filter((part) => part.type === 'toolCall').length
            : 0,
    ).toBe(1);
});

test('only entries carrying editable text are editable', () => {
    const entries = tree();
    expect(isEditable(entries.find((entry) => entry.id === 'u1')!)).toBe(true);
    expect(isEditable(entries.find((entry) => entry.id === 'r1')!)).toBe(false);
});

test('the buffer replays its log and undo drops the last op', () => {
    const buffer = new EditBuffer(tree());
    expect(buffer.dirty).toBe(false);
    buffer.apply({ kind: 'delete', run: { top: 'u4', bottom: 'a4' }, mode: 'subtree' });
    buffer.apply({ kind: 'edit', id: 'u1', text: 'changed' });
    expect(buffer.has('u4')).toBe(false);
    expect(editableText(buffer.entries.find((entry) => entry.id === 'u1')!)).toBe('changed');

    buffer.undo();
    expect(editableText(buffer.entries.find((entry) => entry.id === 'u1')!)).toBe('one');
    expect(buffer.has('u4')).toBe(false);
    expect(buffer.ops.length).toBe(1);

    buffer.reset();
    expect(buffer.dirty).toBe(false);
    expect(buffer.has('u4')).toBe(true);
});

test('a run between two entries is found whichever end is given first', () => {
    const entries = tree();
    expect(runBetween(entries, 'u3', 'u2')).toEqual({ top: 'u2', bottom: 'u3' });
    expect(runBetween(entries, 'u2', 'u3')).toEqual({ top: 'u2', bottom: 'u3' });
    expect(runBetween(entries, 'a3', 'a4')).toBeUndefined();
});

test('the tree resolves labels and sorts siblings by timestamp', () => {
    const entries = [...tree(), label('l1', 'a4', 'u2', 'here')];
    const roots = treeOf(entries);
    expect(roots.length).toBe(1);
    expect(roots[0]!.entry.id).toBe('u1');
    const branch = treeOf(entries)
        .flatMap(function walk(node): string[] {
            return [node.entry.id, ...node.children.flatMap(walk)];
        })
        .join(' ');
    expect(branch).toContain('r1 u3 a3 u4 a4');
    const labelled = treeOf(entries).flatMap(function find(node): string[] {
        return [...(node.entry.id === 'u2' && node.label ? [node.label] : []), ...node.children.flatMap(find)];
    });
    expect(labelled).toEqual(['here']);
});
