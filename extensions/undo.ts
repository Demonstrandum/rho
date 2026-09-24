// undo: the agent takes back one file mutation.
//
// /rewind is the person's. its unit is the prompt (pi-rewind commits on the
// first assistant message of a turn and again at turn end), and its restore is
// `git reset --hard` plus `git clean -fd` over the whole work tree, so taking
// back one bad write also carries away everything else that happened in that
// window, including the person's own edits, and it exists only inside a git
// work tree.
//
// this is the same idea at the size of one tool call. every write, edit and
// remove is journalled with a copy of the file as it was (lib/undo-journal.ts),
// the copy is made on the machine the file is on, and `undo` puts one of them
// back. an undo whose file has changed since the mutation is refused rather
// than applied, because writing old bytes over newer ones is the accident the
// journal exists to take back.
//
// the two mechanisms are not connected and neither can undo the other: after
// an undo, /rewind still has the same checkpoints it had.

import { Type } from '@earendil-works/pi-ai';
import {
    defineTool,
    isToolCallEventType,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { config } from './lib/core/config';
import { currentEnvironment } from './environment';
import { targetFor } from './lib/files/acting-file';
import { LOCAL_BACKUPS, type FileStore } from './lib/files/file-store';
import {
    describe,
    keep,
    look,
    pick,
    pruneBackups,
    recordMutation,
    revert,
    sessionJournal,
    slotFor,
    type Journal,
    type Limits,
    type MutatingTool,
    type Recorded,
} from './lib/files/undo-journal';
import type { StateIdentity } from './lib/core/state-store';
import { dirname } from 'node:path';

const limits = (): Limits => ({
    maxEntries: config.files.undoEntries,
    maxBytes: config.files.undoMaxBytes,
});

/** the state captured before a mutation, waiting for the mutation to finish. */
interface Pending {
    readonly tool: MutatingTool;
    readonly store: FileStore;
    readonly path: string;
    readonly before: Recorded;
}

/**
 * a blocked or abandoned tool call leaves its capture behind, so the map is
 * swept rather than trusted to empty itself.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * a tool result carrying the number its mutation was recorded under, or
 * nothing to patch when the result held no content to carry it.
 */
export function numbered<T extends { type: string }>(content: readonly T[] | undefined, id: number): T[] | null {
    if (!Array.isArray(content)) return null;
    const blocks = [...content];
    const last = blocks.map((block) => block.type).lastIndexOf('text');
    const note = `[undo ${id} takes this back]`;
    if (last < 0) return [...blocks, { type: 'text', text: note } as unknown as T];
    const block = blocks[last] as T & { text: string };
    blocks[last] = { ...block, text: `${block.text}\n${note}` };
    return blocks;
}

export default function (pi: ExtensionAPI) {
    let identity: StateIdentity = { cwd: process.cwd(), sessionId: undefined };
    const pending = new Map<string, { readonly at: number; readonly capture: Pending }>();

    const journal = (): Journal | null =>
        identity.sessionId === undefined ? null : sessionJournal(identity, limits());

    pi.on('session_start', (_event, ctx) => {
        identity = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
        // copies outlive the session that made them, so each start clears what
        // the sessions of a month ago left behind.
        pruneBackups(LOCAL_BACKUPS, 30);
    });

    // ── capture, before the mutation ────────────────────────────────────────
    pi.on('tool_call', async (event, ctx) => {
        if (!config.files.undo) return;
        const tool: MutatingTool | null = isToolCallEventType('write', event)
            ? 'write'
            : isToolCallEventType('edit', event)
              ? 'edit'
              : null;
        if (tool === null) return;
        const raw = (event.input as { path?: unknown }).path;
        if (typeof raw !== 'string') return;
        const target = targetFor(raw, ctx.cwd, currentEnvironment());
        if (target.kind !== 'here') return;
        const session = identity.sessionId;
        if (session === undefined) return;
        const root = await target.store.backupRoot(session);
        const before = await keep(target.store, target.path, slotFor(root, target.path), limits());
        for (const [id, held] of pending) {
            if (Date.now() - held.at > STALE_AFTER_MS) pending.delete(id);
        }
        pending.set(event.toolCallId, {
            at: Date.now(),
            capture: { tool, store: target.store, path: target.path, before },
        });
    });

    // ── record, once it has happened ────────────────────────────────────────
    pi.on('tool_result', async (event) => {
        const held = pending.get(event.toolCallId);
        if (held === undefined) return;
        pending.delete(event.toolCallId);
        const log = journal();
        if (log === null) return;
        const { capture } = held;
        // a failed tool changed nothing, and its copy is only clutter.
        if (event.isError === true) {
            if (capture.before.kind === 'saved' || capture.before.kind === 'directory') {
                try {
                    await capture.store.delete(dirname(capture.before.backup));
                } catch {
                    // the copy stays until the backup root is pruned.
                }
            }
            return;
        }
        const entry = await recordMutation(log, capture.store, {
            tool: capture.tool,
            machine: capture.store.machine,
            path: capture.path,
            before: capture.before,
            after: await look(capture.store, capture.path),
            trashed: null,
        });
        // the number goes back with the result of the call it belongs to, so
        // taking one mutation back does not start with a listing to find out
        // what it was called. remove reports its own the same way.
        const content = numbered(event.content, entry.id);
        return content === null ? undefined : { content };
    });

    // ── the tool ────────────────────────────────────────────────────────────
    pi.registerTool(
        defineTool({
            name: 'undo',
            label: 'undo',
            description:
                'Put back a file this session changed. Every write, edit and remove is recorded '
                + 'with a copy of the file as it was; undo restores one of them, on the machine the '
                + 'file is on. An undo is refused when the file changed after the mutation was '
                + 'recorded, since restoring then would destroy the newer contents. '
                + 'Each record has a number, reported when the mutation happened and listed by '
                + 'action "list"; pass it as id to take back that one mutation rather than the '
                + 'most recent.',
            promptSnippet: 'Take back a write, edit or remove this session made',
            promptGuidelines: [
                'Use undo as soon as a write or edit turns out to have been wrong, rather than writing the file again from memory.',
            ],
            parameters: Type.Object({
                action: Type.Union([Type.Literal('undo'), Type.Literal('list')], {
                    description: 'undo restores; list shows what is recorded. Default undo.',
                }),
                id: Type.Optional(
                    Type.Number({
                        description:
                            'The number of one recorded mutation, as reported when it happened or by action "list". Takes back that mutation and no other.',
                    }),
                ),
                path: Type.Optional(
                    Type.String({ description: 'Restrict to mutations of this path. Default: the most recent mutation of any path.' }),
                ),
                count: Type.Optional(
                    Type.Number({ description: 'How many mutations to take back, newest first. Ignored when id is given. Default 1.' }),
                ),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
                const log = journal();
                const entries = log === null ? [] : log.entries();
                if (entries.length === 0) {
                    return { content: [{ type: 'text', text: 'nothing recorded in this session' }], details: {} };
                }
                const cwd = ctx.cwd;
                const environment = currentEnvironment();
                const asked = params.path === undefined ? undefined : targetFor(params.path, cwd, environment);
                const path = asked !== undefined && asked.kind === 'here' ? asked.path : undefined;

                if (params.action === 'list') {
                    const lines = [...entries].reverse().map(describe);
                    return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
                }

                const chosen = pick(entries, { id: params.id, path, count: params.count ?? 1 });
                if (chosen.length === 0) {
                    const where = params.id !== undefined
                        ? ` under ${params.id}`
                        : path === undefined
                          ? ''
                          : ` for ${path}`;
                    return { content: [{ type: 'text', text: `nothing recorded${where}` }], details: {} };
                }

                const said: string[] = [];
                for (const entry of chosen) {
                    const target = targetFor(
                        entry.machine === 'local' ? `local:${entry.path}` : entry.path,
                        cwd,
                        environment,
                    );
                    if (target.kind !== 'here' || target.store.machine !== entry.machine) {
                        said.push(`${entry.id}: ${entry.path} is on ${entry.machine}, which is not attached now`);
                        continue;
                    }
                    const outcome = await revert(target.store, entry);
                    switch (outcome.kind) {
                        case 'restored':
                            log?.forget(entry.id);
                            said.push(`${entry.id}: ${entry.path} restored from the ${outcome.from}`);
                            break;
                        case 'changed':
                            said.push(
                                `${entry.id}: ${entry.path} was not restored, ${outcome.detail} since the ${entry.tool}. `
                                    + 'Read it and decide what belongs there.',
                            );
                            break;
                        case 'unrecoverable':
                            said.push(`${entry.id}: ${entry.path} cannot be restored, ${outcome.detail}`);
                            break;
                        case 'failed':
                            said.push(`${entry.id}: ${entry.path} was not restored: ${outcome.detail}`);
                            break;
                    }
                }
                return { content: [{ type: 'text', text: said.join('\n') }], details: {} };
            },
        }),
    );
}
