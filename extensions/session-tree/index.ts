// the session tree as an edit surface: select a span of a branch, then delete
// it, summarise it, prune around it, or rewrite one message, and commit the
// result as a copy of the whole session.
//
// pi matches "/tree" in InteractiveMode's submit handler before extension
// commands are consulted, so a command of that name would never run. the view
// is installed by patching InteractiveMode.prototype.showTreeSelector, which
// is what "/tree", esc esc, and the app.session.tree binding (shift+ctrl+t)
// all call, so one patch covers every way in and none of them is registered
// here. registering shift+ctrl+t as an extension shortcut takes the binding
// off pi's own action and pi reports the conflict.
//
// what the edits are applied to:
//
//   the buffer    lib/session-edit.ts holds the entries and the ops over them.
//                 nothing reaches disk while the view is open, so the tree
//                 redraws after each op and `u` walks back through them.
//   the commit    a dirty buffer is written by lib/session-file.ts as a new
//                 session file holding every branch, and the session switches
//                 to it. the file being edited is never written: it is the
//                 backup, and it is what /resume goes back to.
//   the tree      the view can no longer read its tree off the session
//                 manager, because the buffer's tree is not on disk, so
//                 treeOf() rebuilds pi's node shape from the buffer.
//
// the keys are lib/tree-keys.ts and the gutter is lib/tree-gutter.ts, both
// free of pi types so the bindings and the painting are tested on their own.
// what normal mode does not claim is handed to pi's own key handling, which is
// what keeps folding, filters, labels, paging, and copy working unchanged.

import {
    InteractiveMode,
    TreeSelectorComponent,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { Component, Container } from '@earendil-works/pi-tui';
import type { AssistantMessage, TextContent } from '@earendil-works/pi-ai';
import {
    EditBuffer,
    editableText,
    isEditable,
    leafBelow,
    pathTo,
    runBetween,
    runIds,
    treeOf,
    unitRun,
    type EntryId,
    type Run,
} from './edit';
import { writeSessionCopy } from '../lib/session-file';
import { markRows, type RowState } from './gutter';
import { INITIAL_KEYS, NORMAL_HINTS, SEARCH_HINTS, step, type KeyState, type Verb } from './keys';
import { oneLine, preview, quantity } from '../lib/text';

// ---- what is reached inside pi ------------------------------------------
//
// every member named here is private in pi's declarations. naming them one by
// one keeps the reach to what this file actually uses, and makes a version of
// pi that moves one of them fail at the patch rather than at a keystroke.

interface FlatNode {
    readonly node: { readonly entry: SessionEntry };
}

interface TreeListInternals extends Component {
    filteredNodes: readonly FlatNode[];
    selectedIndex: number;
    maxVisibleLines: number;
    visibleParentMap: Map<EntryId, EntryId | null>;
    visibleChildrenMap: Map<EntryId, EntryId[]>;
    copySelected(): void;
    render(width: number): string[];
}

interface SelectorInternals {
    labelInput: unknown;
    getTreeList(): TreeListInternals;
    handleInput(keyData: string): void;
}

interface SessionManagerLike {
    getEntries(): SessionEntry[];
    getLeafId(): string | null;
    getSessionFile(): string | undefined;
    getSessionDir(): string;
    getCwd(): string;
}

interface SelectorHandle {
    component: Component;
    focus: unknown;
    dispose?: () => void;
}

interface ModeInternals {
    sessionManager: SessionManagerLike;
    ui: { terminal: { rows: number }; requestRender(): void };
    settingsManager: { getTreeFilterMode(): 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all' };
    runtimeHost: {
        switchSession(path: string, options?: unknown): Promise<{ cancelled?: boolean }>;
    };
    // the leaf is moved by the agent session, not by the runtime host: the host
    // forks and switches files, and navigating inside one is the session's.
    session: {
        navigateTree(
            targetId: string,
            options?: { summarize?: boolean; customInstructions?: string },
        ): Promise<{ cancelled?: boolean; aborted?: boolean; editorText?: string }>;
    };
    chatContainer: { clear(): void };
    editor: { getText(): string; setText(text: string): void };
    renderInitialMessages(): void;
    showSelector(create: (done: () => void) => SelectorHandle): void;
    showStatus(message: string): void;
    showError(message: string): void;
    showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
    showExtensionEditor(title: string, prefill?: string): Promise<string | undefined>;
    showTreeSelector(initialSelectedId?: string): void;
}

// ---- the edit session ---------------------------------------------------

interface EditSession {
    /** the file the buffer was loaded from; a switch invalidates the buffer. */
    readonly file: string | undefined;
    readonly buffer: EditBuffer;
    anchor: EntryId | null;
    /** set by `v`: the selection survives an unshifted move. */
    holding: boolean;
    keys: KeyState;
}

let session: EditSession | null = null;
let context: ExtensionContext | null = null;

function editSession(mode: ModeInternals): EditSession {
    const file = mode.sessionManager.getSessionFile();
    if (session && session.file === file) return session;
    session = {
        file,
        buffer: new EditBuffer(mode.sessionManager.getEntries()),
        anchor: null,
        holding: false,
        keys: INITIAL_KEYS,
    };
    return session;
}

/** the span the verbs act on: the selection, or the unit under the cursor. */
function currentRun(entries: readonly SessionEntry[], edit: EditSession, cursor: EntryId): Run | undefined {
    if (edit.anchor === null) return unitRun(entries, pathTo(entries, cursor), cursor);
    return runBetween(entries, edit.anchor, cursor);
}

// ---- the status row -----------------------------------------------------

function hintText(keys: KeyState): string {
    const hints = keys.mode === 'search' ? SEARCH_HINTS : NORMAL_HINTS;
    return hints.map(([key, label]) => `${key} ${label}`).join('  ');
}

function statusRow(edit: EditSession, selected: () => number): Component {
    return {
        invalidate() {},
        render(width: number): string[] {
            const left: string[] = [];
            if (edit.keys.mode === 'search') left.push('search');
            if (edit.keys.count !== '') left.push(`count ${edit.keys.count}`);
            const rows = selected();
            if (rows > 1) left.push(quantity(rows, 'entry', 'entries') + ' selected');
            if (edit.buffer.dirty) left.push(`${quantity(edit.buffer.ops.length, 'edit')} pending`);
            const state = left.length > 0 ? `  ${left.join(' \u00b7 ')}` : '';
            return [preview(`  ${hintText(edit.keys)}`, width), preview(state, width)].filter(
                (line) => line.trim() !== '',
            );
        },
        handleInput() {},
    } as Component;
}

// ---- summarising --------------------------------------------------------

const SUMMARY_PROMPT = [
    'You are summarising a span of a coding session transcript.',
    'The summary replaces those messages in the context of the session that continues after it.',
    'State what was asked, what was done, what was decided, and what the state of the work is.',
    'Name files, identifiers, and commands exactly. Keep every fact the later work needs.',
    'Write prose, no headings, no preamble about the summary itself.',
].join('\n');

function transcriptOf(entries: readonly SessionEntry[], run: Run): string {
    const ids = new Set(runIds(entries, run));
    const lines: string[] = [];
    for (const entry of entries) {
        if (!ids.has(entry.id)) continue;
        if (entry.type === 'custom_message') {
            lines.push(`summary: ${editableText(entry)}`);
            continue;
        }
        if (entry.type !== 'message') continue;
        const message = entry.message;
        if (message.role === 'user') lines.push(`user: ${editableText(entry)}`);
        else if (message.role === 'assistant') {
            const text = editableText(entry);
            if (text.trim() !== '') lines.push(`assistant: ${text}`);
            for (const part of (message as AssistantMessage).content) {
                if (part.type === 'toolCall') lines.push(`tool call: ${part.name} ${oneLine(JSON.stringify(part.arguments)).slice(0, 400)}`);
            }
        } else if (message.role === 'toolResult') {
            const text = message.content
                .filter((part): part is TextContent => part.type === 'text')
                .map((part) => part.text)
                .join('\n');
            lines.push(`tool result: ${preview(text, 400)}`);
        } else if (message.role === 'bashExecution') {
            lines.push(`bash: ${message.command}`);
        }
    }
    return lines.join('\n\n');
}

async function summarise(
    ctx: ExtensionContext,
    entries: readonly SessionEntry[],
    run: Run,
    instructions: string | undefined,
): Promise<string> {
    const model = ctx.model;
    if (!model) throw new Error('no model is loaded to summarise with');
    const prompt = instructions?.trim() ? `${SUMMARY_PROMPT}\n\nFocus on: ${instructions.trim()}` : SUMMARY_PROMPT;
    const response = await ctx.modelRegistry.complete(
        model,
        {
            systemPrompt: prompt,
            messages: [
                {
                    role: 'user',
                    content: [{ type: 'text', text: `<transcript>\n${transcriptOf(entries, run)}\n</transcript>` }],
                    timestamp: Date.now(),
                },
            ],
        },
        { maxTokens: 4096 },
    );
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage ?? `summariser ${response.stopReason}`);
    }
    const text = response.content
        .filter((part): part is TextContent => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
    if (text === '') throw new Error('the summariser returned nothing');
    return text;
}

// ---- committing ---------------------------------------------------------

/**
 * write the edited tree beside the session it came from and switch to it.
 *
 * the leaf is placed afterwards rather than in the file, because entry ids
 * survive the copy and navigateTree is what re-renders the transcript.
 */
async function commit(mode: ModeInternals, edit: EditSession, leaf: EntryId | undefined): Promise<void> {
    const path = writeSessionCopy({
        sessionDir: mode.sessionManager.getSessionDir(),
        cwd: mode.sessionManager.getCwd(),
        parentSession: edit.file,
        entries: edit.buffer.entries,
    });
    session = null;
    const switched = await mode.runtimeHost.switchSession(path);
    if (switched.cancelled) {
        mode.showStatus('Session switch cancelled; the edits are in the new file');
        return;
    }
    // the entry the cursor was on can be one the edits removed, and a leaf the
    // copy does not contain is not a place to navigate to.
    if (leaf !== undefined && edit.buffer.entries.some((entry) => entry.id === leaf)) {
        await navigateTo(mode, leaf);
    }
    mode.showStatus(`Committed ${quantity(edit.buffer.ops.length, 'edit')} to a copy of the session`);
}

/**
 * move the leaf, and redraw the transcript for its new position.
 *
 * this is the tail of pi's own tree navigation: the session moves the leaf and
 * reports the text to restore, and the view has to be rebuilt from the new
 * branch, since nothing else repaints it.
 */
async function navigateTo(
    mode: ModeInternals,
    target: EntryId,
    options?: { summarize?: boolean; customInstructions?: string },
): Promise<void> {
    const result = await mode.session.navigateTree(target, options);
    if (result.cancelled || result.aborted) {
        mode.showStatus('Navigation cancelled');
        return;
    }
    mode.chatContainer.clear();
    mode.renderInitialMessages();
    if (result.editorText && mode.editor.getText().trim() === '') mode.editor.setText(result.editorText);
    mode.showStatus('Navigated to selected point');
}

/** pi's own branch-summary prompt, for the case where nothing was edited. */
async function navigateClean(mode: ModeInternals, target: EntryId): Promise<void> {
    const choice = await mode.showExtensionSelector('Summarize branch?', [
        'No summary',
        'Summarize',
        'Summarize with custom prompt',
    ]);
    if (choice === undefined) {
        mode.showTreeSelector(target);
        return;
    }
    const custom =
        choice === 'Summarize with custom prompt'
            ? await mode.showExtensionEditor('Custom summarization instructions')
            : undefined;
    if (choice === 'Summarize with custom prompt' && custom === undefined) {
        mode.showTreeSelector(target);
        return;
    }
    await navigateTo(mode, target, {
        summarize: choice !== 'No summary',
        ...(custom !== undefined && { customInstructions: custom }),
    });
}

// ---- the view -----------------------------------------------------------

/** rows reachable from the cursor without crossing a branch point. */
function reachableRows(list: TreeListInternals): Set<number> {
    const rows = new Set<number>();
    const idAt = (index: number): EntryId | undefined => list.filteredNodes[index]?.node.entry.id;
    const cursor = list.selectedIndex;
    for (let at = cursor - 1; at >= 0; at -= 1) {
        const below = idAt(at + 1);
        if (below === undefined || list.visibleParentMap.get(below) !== idAt(at)) break;
        rows.add(at);
    }
    for (let at = cursor + 1; at < list.filteredNodes.length; at += 1) {
        const above = idAt(at - 1);
        const children = above === undefined ? [] : (list.visibleChildrenMap.get(above) ?? []);
        if (children.length !== 1 || children[0] !== idAt(at)) break;
        rows.add(at);
    }
    return rows;
}

function open(mode: ModeInternals, initialSelectedId?: string): void {
    const edit = editSession(mode);
    const entries = edit.buffer.entries;
    const tree = treeOf(entries);
    if (tree.length === 0) {
        mode.showStatus('No entries in session');
        return;
    }
    const leafId = mode.sessionManager.getLeafId();
    const startAt = initialSelectedId !== undefined && edit.buffer.has(initialSelectedId) ? initialSelectedId : undefined;

    mode.showSelector((done) => {
        const selector = new TreeSelectorComponent(
            tree,
            leafId !== null && edit.buffer.has(leafId) ? leafId : null,
            mode.ui.terminal.rows,
            (entryId) => void confirm(entryId),
            () => void cancel(),
            undefined,
            startAt,
            mode.settingsManager.getTreeFilterMode(),
        );
        const inner = selector as unknown as SelectorInternals;
        const list = inner.getTreeList();

        const cursorId = (): EntryId | undefined => list.filteredNodes[list.selectedIndex]?.node.entry.id;
        const selectedIds = (): ReadonlySet<EntryId> => {
            const cursor = cursorId();
            if (cursor === undefined || edit.anchor === null) return new Set();
            const run = runBetween(entries, edit.anchor, cursor);
            return run ? new Set(runIds(entries, run)) : new Set();
        };

        // the selection band and the relative numbers are painted over the two
        // gutter columns of rows pi has already rendered, so nothing about the
        // row's own content, colour, or clipping is reproduced here.
        const renderList = list.render.bind(list);
        list.render = (width: number): string[] => {
            const lines = renderList(width);
            const rows = Math.min(list.maxVisibleLines, list.filteredNodes.length);
            const first = Math.max(
                0,
                Math.min(list.selectedIndex - Math.floor(list.maxVisibleLines / 2), list.filteredNodes.length - rows),
            );
            const ids = selectedIds();
            const selected = new Set<number>();
            list.filteredNodes.forEach((flat, at) => {
                if (ids.has(flat.node.entry.id)) selected.add(at);
            });
            const state: RowState = {
                cursor: list.selectedIndex,
                selected,
                reachable: reachableRows(list),
                firstRow: first,
            };
            return markRows(lines, rows, state);
        };

        (selector as unknown as Container).addChild(statusRow(edit, () => selectedIds().size));

        const reopen = (): void => {
            done();
            mode.showTreeSelector(cursorId());
        };

        const moveTo = (row: number): void => {
            const clamped = Math.max(0, Math.min(list.filteredNodes.length - 1, row));
            list.selectedIndex = clamped;
            list.invalidate();
            mode.ui.requestRender();
        };

        // shift is held rather than switched on: a shifted move extends the
        // selection, and an unshifted one drops it and moves, the way a text
        // editor behaves. `v` is for a selection that outlives the keys, since
        // the verbs are typed after it and shift cannot be held through them.
        const move = (by: number, extending: boolean): void => {
            if (!extending && !edit.holding) edit.anchor = null;
            const reachable = reachableRows(list);
            const target =
                Math.abs(by) > 1
                    ? // a count promises the row it numbered, and rows past a
                      // branch point carry no number, so it stops there.
                      clampToRun(list.selectedIndex, by, reachable)
                    : list.selectedIndex + by;
            if (extending && edit.anchor === null) edit.anchor = cursorId() ?? null;
            const before = list.selectedIndex;
            moveTo(target);
            if (!extending) return;
            const cursor = cursorId();
            if (cursor === undefined || edit.anchor === null) return;
            if (runBetween(entries, edit.anchor, cursor) === undefined) {
                moveTo(before);
                mode.showStatus('A selection cannot cross a branch point');
            }
        };

        const extendTo = (end: 'root' | 'leaf'): void => {
            const cursor = cursorId();
            if (cursor === undefined) return;
            if (edit.anchor === null) edit.anchor = cursor;
            const path = pathTo(entries, end === 'leaf' ? leafBelow(entries, edit.anchor) : edit.anchor);
            const target = end === 'leaf' ? path[path.length - 1] : path[0];
            const row = list.filteredNodes.findIndex((flat) => flat.node.entry.id === target);
            if (row < 0) {
                mode.showStatus('That end of the branch is hidden by the filter');
                return;
            }
            moveTo(row);
        };

        async function confirm(entryId: string): Promise<void> {
            if (!edit.buffer.dirty) {
                if (entryId === mode.sessionManager.getLeafId()) {
                    done();
                    mode.showStatus('Already at this point');
                    return;
                }
                done();
                await navigateClean(mode, entryId);
                return;
            }
            done();
            await commit(mode, edit, entryId);
        }

        async function cancel(): Promise<void> {
            if (!edit.buffer.dirty) {
                session = null;
                done();
                mode.ui.requestRender();
                return;
            }
            const cursor = cursorId();
            done();
            const choice = await mode.showExtensionSelector(
                `${quantity(edit.buffer.ops.length, 'edit')} not committed`,
                ['Keep editing', 'Commit to a copy', 'Discard'],
            );
            if (choice === 'Commit to a copy') {
                await commit(mode, edit, cursor);
                return;
            }
            if (choice === 'Discard') {
                session = null;
                mode.ui.requestRender();
                return;
            }
            mode.showTreeSelector(cursor);
        }

        async function verb(which: Verb): Promise<void> {
            const cursor = cursorId();
            if (cursor === undefined) return;
            if (which === 'copy') {
                list.copySelected();
                return;
            }
            const run = currentRun(entries, edit, cursor);
            if (!run) {
                mode.showStatus('A selection cannot cross a branch point');
                return;
            }
            const span = runIds(entries, run);

            if (which === 'prune') {
                edit.buffer.apply({ kind: 'prune', to: run.bottom });
                edit.anchor = null;
                edit.holding = false;
                reopen();
                return;
            }
            if (which === 'edit') {
                if (span.length !== 1) {
                    mode.showStatus('Editing takes one entry');
                    return;
                }
                const entry = edit.buffer.entries.find((item) => item.id === cursor);
                if (!entry || !isEditable(entry)) {
                    mode.showStatus('That entry has no text to edit');
                    return;
                }
                done();
                const text = await mode.showExtensionEditor('Edit message', editableText(entry));
                if (text === undefined) {
                    mode.showTreeSelector(cursor);
                    return;
                }
                edit.buffer.apply({ kind: 'edit', id: cursor, text });
                edit.anchor = null;
                edit.holding = false;
                mode.showTreeSelector(cursor);
                return;
            }
            if (which === 'delete') {
                done();
                const choice = await mode.showExtensionSelector(`Delete ${quantity(span.length, 'entry', 'entries')}?`, [
                    'Keep what follows',
                    'Delete what follows too',
                ]);
                if (choice === undefined) {
                    mode.showTreeSelector(cursor);
                    return;
                }
                const above = entries.find((entry) => entry.id === run.top)?.parentId ?? undefined;
                edit.buffer.apply({
                    kind: 'delete',
                    run,
                    mode: choice === 'Keep what follows' ? 'rechain' : 'subtree',
                });
                edit.anchor = null;
                edit.holding = false;
                // the cursor lands where the deleted span was, which is the
                // entry above it: the span itself is not there to return to.
                mode.showTreeSelector(above);
                return;
            }

            // summarize
            const ctx = context;
            if (!ctx) {
                mode.showError('No extension context to summarise with');
                return;
            }
            done();
            const focus = await mode.showExtensionEditor(
                `Summarise ${quantity(span.length, 'entry', 'entries')}: focus (optional)`,
            );
            if (focus === undefined) {
                mode.showTreeSelector(cursor);
                return;
            }
            mode.showStatus(`Summarising ${quantity(span.length, 'entry', 'entries')}...`);
            let landOn: EntryId | undefined = entries.find((entry) => entry.id === run.top)?.parentId ?? undefined;
            try {
                const before = new Set(edit.buffer.entries.map((entry) => entry.id));
                const summary = await summarise(ctx, edit.buffer.entries, run, focus);
                edit.buffer.apply({ kind: 'summarize', run, summary });
                landOn = edit.buffer.entries.find((entry) => !before.has(entry.id))?.id ?? landOn;
                edit.anchor = null;
                edit.holding = false;
                mode.showStatus('Summarised');
            } catch (error) {
                mode.showError(error instanceof Error ? error.message : String(error));
            }
            mode.showTreeSelector(landOn);
        }

        inner.handleInput = (keyData: string): void => {
            const passthrough = (): void => innerHandle(keyData);
            if (inner.labelInput) {
                passthrough();
                return;
            }
            const next = step(edit.keys, keyData);
            edit.keys = next.state;
            const action = next.action;
            switch (action.kind) {
                case 'passthrough':
                    passthrough();
                    return;
                case 'none':
                    mode.ui.requestRender();
                    return;
                case 'mode':
                    mode.ui.requestRender();
                    return;
                case 'move':
                    move(action.by, false);
                    return;
                case 'extend':
                    move(action.by, true);
                    return;
                case 'select-toggle':
                    edit.holding = edit.anchor === null;
                    edit.anchor = edit.holding ? (cursorId() ?? null) : null;
                    mode.ui.requestRender();
                    return;
                case 'extend-to':
                    extendTo(action.end);
                    return;
                case 'verb':
                    void verb(action.verb);
                    return;
                case 'undo': {
                    if (!edit.buffer.dirty) {
                        mode.showStatus('Nothing to undo');
                        return;
                    }
                    if (action.all) edit.buffer.reset();
                    else edit.buffer.undo();
                    edit.anchor = null;
                    edit.holding = false;
                    reopen();
                    return;
                }
                case 'escape':
                    if (edit.anchor !== null) {
                        edit.anchor = null;
                        edit.holding = false;
                        mode.ui.requestRender();
                        return;
                    }
                    passthrough();
                    return;
                case 'confirm':
                    passthrough();
                    return;
            }
        };
        const innerHandle = TreeSelectorComponent.prototype.handleInput.bind(selector);

        return { component: selector as unknown as Component, focus: selector };
    });
}

/** a counted move stops where the numbers stop: at the branch point. */
function clampToRun(cursor: number, by: number, reachable: ReadonlySet<number>): number {
    const direction = by > 0 ? 1 : -1;
    let at = cursor;
    for (let taken = 0; taken < Math.abs(by); taken += 1) {
        const next = at + direction;
        if (!reachable.has(next)) break;
        at = next;
    }
    return at;
}

// ---- installation -------------------------------------------------------

const patched = Symbol.for('rho.session-tree.patched');

type Patchable = typeof InteractiveMode.prototype & { [patched]?: boolean };

export default function (pi: ExtensionAPI) {
    pi.on('session_start', (_event, ctx) => {
        context = ctx;
    });

    const proto = InteractiveMode.prototype as Patchable;
    if (!proto[patched]) {
        proto[patched] = true;
        const original = (proto as unknown as Record<string, unknown>).showTreeSelector as (
            this: ModeInternals,
            id?: string,
        ) => void;
        Object.defineProperty(proto, 'showTreeSelector', {
            configurable: true,
            writable: true,
            value: function (this: ModeInternals, initialSelectedId?: string): void {
                try {
                    open(this, initialSelectedId);
                } catch (error) {
                    // a patch that throws must not take the tree with it.
                    this.showError(`tree view: ${error instanceof Error ? error.message : String(error)}`);
                    original.call(this, initialSelectedId);
                }
            },
        });
    }

    pi.registerCommand('session-copy', {
        description: 'Duplicate the whole session, every branch, and switch to the copy',
        handler: async (_args, ctx) => {
            const path = writeSessionCopy({
                sessionDir: ctx.sessionManager.getSessionDir(),
                cwd: ctx.cwd,
                parentSession: ctx.sessionManager.getSessionFile(),
                entries: ctx.sessionManager.getEntries(),
            });
            await ctx.switchSession(path);
        },
    });

    pi.registerCommand('session-backup', {
        description: 'Write a copy of the whole session and stay in this one',
        handler: async (_args, ctx) => {
            const path = writeSessionCopy({
                sessionDir: ctx.sessionManager.getSessionDir(),
                cwd: ctx.cwd,
                parentSession: ctx.sessionManager.getSessionFile(),
                entries: ctx.sessionManager.getEntries(),
            });
            ctx.ui.notify(`Backed up to ${path}`, 'info');
        },
    });
}
