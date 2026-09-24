// write stops destroying files, and remove is how a file is destroyed on
// purpose.
//
// pi's write is four lines of mkdir and writeFile (dist/core/tools/write.js).
// it does not stat the path, does not require that the file was ever read, and
// does not compare what is there with what the model last saw. so a model that
// read a file at the start of a turn, or never read it at all, replaces every
// byte in it with one call and the previous contents exist nowhere: not in
// git, if the file was untracked, and not in the session.
//
// [files] overwrite = 'refuse' blocks that call. the file is not empty, so the
// write would destroy bytes, and destroying bytes is a thing the agent has to
// say it means:
//
//   edit          change part of a file, with the old text as the anchor
//   remove        put the whole file in the machine's trash, then write
//
// a write is allowed through when the target is absent, when it is empty, and
// when its contents already hash to what is being written, since none of those
// destroy anything.
//
// remove uses the trash rather than unlink: /usr/bin/trash on macOS 15, gio or
// trash-put on linux, each of which keeps the item where the person can put it
// back without asking the agent for anything. the mutation is also journalled
// (lib/undo-journal.ts), so the agent can put it back itself with undo.

import { createHash } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import {
    defineTool,
    isToolCallEventType,
    withFileMutationQueue,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { config } from './lib/core/config';
import { currentEnvironment } from './environment';
import { targetFor, type Target } from './lib/files/acting-file';
import type { Stat } from './lib/files/file-store';
import { keep, recordMutation, sessionJournal, slotFor, type Limits, type Recorded } from './lib/files/undo-journal';
import type { StateIdentity } from './lib/core/state-store';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const limits = (): Limits => ({
    maxEntries: config.files.undoEntries,
    maxBytes: config.files.undoMaxBytes,
});

/**
 * whether a write may replace what is at the path, given what is there and
 * what it would write. null means the write destroys nothing.
 */
export function verdict(path: string, now: Stat, digest: string | null, content: string): string | null {
    if (now.kind === 'absent') return null;
    if (now.kind === 'directory') return `${path} is a directory, so write cannot replace it.`;
    if (now.bytes === 0) return null;
    // a write of the bytes already there destroys nothing, and refusing it
    // costs a turn to arrive back where the file already is.
    if (digest !== null && digest === sha256(content)) return null;
    return refusal(path, now.bytes);
}

/** what the model is told instead of the write it asked for. */
export function refusal(path: string, bytes: number): string {
    return (
        `${path} already holds ${bytes} bytes, and write replaces a file whole. `
        + 'Read it and use edit to change the part you mean, or call remove on it '
        + '(it goes to the machine\'s trash, and undo puts it back) and then write. '
        + 'If you have not read it this turn, read it first: what is there now may '
        + 'not be what you last saw.'
    );
}

export default function (pi: ExtensionAPI) {
    let identity: StateIdentity = { cwd: process.cwd(), sessionId: undefined };
    pi.on('session_start', (_event, ctx) => {
        identity = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
    });

    pi.on('tool_call', async (event, ctx) => {
        if (config.files.overwrite === 'allow') return;
        if (!isToolCallEventType('write', event)) return;
        const target = targetFor(event.input.path, ctx.cwd, currentEnvironment());
        // a path addressed at a machine nothing is attached to cannot be
        // checked without opening a connection of this extension's own.
        if (target.kind !== 'here') return;
        const now = await target.store.stat(target.path);
        if (now.kind === 'absent') return;
        const digest = now.kind === 'file' && now.bytes > 0 ? await target.store.digest(target.path) : null;
        const reason = verdict(target.path, now, digest, event.input.content);
        return reason === null ? undefined : { block: true, reason };
    });

    pi.registerTool(
        defineTool({
            name: 'remove',
            label: 'remove',
            description:
                "Move a file or directory to the machine's trash, where the person can restore it, "
                + 'and record it so undo can put it back. Use this when a file has to stop existing, '
                + 'or before writing a new file over the place an old one occupies. '
                + 'Paths follow the same addressing as read and write: a plain path means the machine '
                + 'the tools are acting on, "local:/abs/path" means this one.',
            promptSnippet: 'Send a file or directory to the trash, undoably',
            promptGuidelines: [
                'Use remove rather than rm, and rather than writing an empty file over something you want gone.',
                'Use remove before write when the target already holds bytes you mean to discard.',
            ],
            parameters: Type.Object({
                path: Type.String({ description: 'Path to remove (relative or absolute)' }),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
                const target: Target = targetFor(params.path, ctx.cwd, currentEnvironment());
                if (target.kind === 'elsewhere') {
                    throw new Error(
                        `${params.path} is on ${target.address}, which this session is not attached to: `
                            + 'attach it with the environment tool first.',
                    );
                }
                const { store, path } = target;
                const session = identity.sessionId;
                return withFileMutationQueue(path, async () => {
                    const now = await store.stat(path);
                    if (now.kind === 'absent') throw new Error(`no such path: ${path}`);

                    const journal = session === undefined || !config.files.undo
                        ? null
                        : sessionJournal(identity, limits());
                    let before: Recorded = { kind: 'unsaved', why: 'unreadable', bytes: 0 };
                    if (journal !== null && session !== undefined) {
                        const root = await store.backupRoot(session);
                        before = await keep(store, path, slotFor(root, path), limits());
                    }

                    const outcome = config.files.removeTo === 'trash' ? await store.trash(path) : null;
                    if (outcome !== null && outcome.kind === 'failed') {
                        throw new Error(`${path} was not removed: ${outcome.message}`);
                    }
                    if (outcome === null) await store.delete(path);
                    const trashed = outcome === null ? null : outcome.at;

                    const entry = journal === null
                        ? null
                        : await recordMutation(journal, store, {
                              tool: 'remove',
                              machine: store.machine,
                              path,
                              before,
                              after: { kind: 'absent' },
                              trashed,
                          });

                    const where = trashed === null ? 'removed' : `moved to ${trashed}`;
                    const undoable = entry === null ? '' : ` undo ${entry.id} puts it back.`;
                    return {
                        content: [{ type: 'text', text: `${path} ${where}.${undoable}` }],
                        details: {},
                    };
                });
            },
        }),
    );
}
