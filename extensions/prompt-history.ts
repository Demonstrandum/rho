// persistent prompt history: both sent prompts and unsent drafts survive across
// sessions and are reachable via arrow keys and /history.
//
// patches Editor.prototype (the parent of CustomEditor) to capture:
//   - sent prompts (in submitValue, after the original)
//   - unsent drafts (in navigateHistory, before overwriting)
//   - the live draft on shutdown or debounced while typing
//
// on first arrow-key use, stored entries are appended to pi's own history
// array, so they become reachable through the standard navigation. /history
// opens a picker over the full log.
//
// the search key ([history] search-key, ctrl+f by default) opens an incremental
// search: typing narrows the log, the match under the cursor is shown in full
// with the hit marked, and enter puts it in the editor. the search key itself,
// and ctrl+r, step to an older match inside the overlay, so the shell habit
// works once the overlay is open even though ctrl+r parks a prompt outside it
// (see stash.ts).
//
// ctrl+f is pi's tui.editor.cursorRight, alongside the right arrow. an
// extension shortcut wins the key but pi reports the overlap at every start, so
// the key is taken off the built-in once, in keybindings.json, leaving the arrow
// to move the cursor. a reserved binding (ctrl+t, ctrl+g, ctrl+o and the rest of
// pi's RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS) could not be claimed at
// all: pi skips an extension shortcut that names one.

import {
    DynamicBorder,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from '@earendil-works/pi-coding-agent';
import {
    Editor,
    Container,
    SelectList,
    Text,
    type KeyId,
    type SelectItem,
    type SelectListTheme,
    matchesKey,
    type TUI,
} from '@earendil-works/pi-tui';
import {
    HistoryLog,
    matchWindow,
    parseHistoryState,
    ReverseSearch,
    type HistoryEntry,
    type HistoryEntryId,
    type HistoryState,
    type SearchView,
} from './lib/session/prompt-history';
import { releaseKey } from './lib/core/keybindings-store';
import { PersistedState, type StateScope } from './lib/core/state-store';
import { config } from './lib/core/config';
import { ago, preview as previewOf } from './lib/core/text';

const STATE_NAME = 'prompt-history';
const PREVIEW_CHARS = 72;
const KEY_DELETE = 'd';
const KEY_UNDO = 'u';

// search overlay keys. the list is the visible part of the matches; the cursor
// may sit anywhere in them, so the window scrolls with it.
const SEARCH_ROWS = 8;
// the rows are newest first, so down goes towards older entries and up towards
// newer ones: the arrows follow the list on screen, not the shell's idea of
// which direction the past is in. the search key and ctrl+r step older, which
// is down the list and is also what they do in a shell.
const SEARCH_KEY_OLDER: readonly KeyId[] = ['down', 'ctrl+n', 'ctrl+r'];
const SEARCH_KEY_NEWER: readonly KeyId[] = ['up', 'ctrl+p'];
const SEARCH_KEY_CLEAR: KeyId = 'ctrl+u';
const SEARCH_KEY_ACCEPT: KeyId = 'enter';
const SEARCH_KEY_BACKSPACE: KeyId = 'backspace';
const SEARCH_KEY_CANCEL: readonly KeyId[] = ['escape', 'ctrl+c'];
// [history] search-key is free text in rho.toml; pi's own key vocabulary is
// what it has to name, and a key pi does not know simply never fires.
const SEARCH_KEY = config.history.searchKey as KeyId;
// what the editor may carry into the query: longer than this, or more than one
// line, and it is a draft rather than a search term.
const seedLimit = (): number => config.history.seedQueryChars;

// branded symbol so we can mark editors as seeded without polluting the type
const SEEDED = Symbol('rho-history-seeded');

interface SeededEditor {
    [SEEDED]?: boolean;
}

function persistScope(): StateScope | null {
    const setting = config.history.persist;
    return setting === 'off' ? null : setting;
}

const preview = (text: string): string => previewOf(text, PREVIEW_CHARS);
const age = ago;

export default function (pi: ExtensionAPI) {
    const scope = persistScope();
    if (scope === null) return; // off: let pi handle it alone

    let store: PersistedState<HistoryState> | null = null;
    let log: HistoryLog | null = null;
    let ctx: ExtensionContext | null = null;

    // debounced draft capture while typing
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDraftText = '';

    const persist = (state: HistoryState) => {
        store?.write(state);
    };

    // capture the current editor text as an unsent draft, deduplicated
    const captureDraft = (editor: InstanceType<typeof Editor>) => {
        if (!config.history.saveDrafts || !log) return;
        const text = editor.getText?.() ?? '';
        if (text.trim() && text !== lastDraftText) {
            log.record(text, false);
            lastDraftText = text;
        }
    };

    // seed pi's history array with stored entries on first navigation
    const seedIfNeeded = (editor: InstanceType<typeof Editor> & SeededEditor) => {
        if (editor[SEEDED] || !log) return;
        editor[SEEDED] = true;

        // pi's history is newest-first, so are ours; append ours after pi's
        const piHistory = (editor as unknown as { history: string[] }).history;
        const piSet = new Set(piHistory);
        for (const entry of log.all()) {
            if (!piSet.has(entry.text)) {
                piHistory.push(entry.text);
            }
        }
    };

    // patch Editor.prototype methods (Editor is the parent of CustomEditor)
    type EditorProto = {
        submitValue: () => void;
        navigateHistory: (direction: number) => void;
        exitHistoryBrowsing: () => void;
        getText: () => string;
        history: string[];
        historyIndex: number;
        historyDraft: unknown;
        onChange?: (text: string) => void;
    };

    const proto = Editor.prototype as unknown as EditorProto;
    const originalSubmitValue = proto.submitValue;
    const originalNavigateHistory = proto.navigateHistory;

    proto.submitValue = function (this: EditorProto) {
        const text = this.getText?.() ?? '';
        originalSubmitValue.call(this);
        // record sent prompt after submit clears the editor
        if (text.trim() && log) {
            log.record(text, true);
            lastDraftText = '';
        }
    };

    proto.navigateHistory = function (this: EditorProto & SeededEditor, direction: number) {
        seedIfNeeded(this as unknown as InstanceType<typeof Editor> & SeededEditor);

        // capture draft before navigating away from index -1
        if (this.historyIndex === -1 && direction === -1) {
            const text = this.getText?.() ?? '';
            if (text.trim() && log && config.history.saveDrafts) {
                log.record(text, false);
                lastDraftText = text;
            }
        }

        originalNavigateHistory.call(this, direction);
    };

    // pi's exitHistoryBrowsing nulls out historyDraft when you type while
    // browsing, which breaks arrow-down restore. patch it to preserve the draft.
    const originalExitHistoryBrowsing = proto.exitHistoryBrowsing;
    proto.exitHistoryBrowsing = function (this: EditorProto) {
        const savedDraft = this.historyDraft;
        originalExitHistoryBrowsing.call(this);
        // restore the draft so arrow-down can still reach it
        this.historyDraft = savedDraft;
    };

    // wrap onChange for debounced draft capture
    const patchOnChange = (editor: InstanceType<typeof Editor>) => {
        const editorAny = editor as unknown as { onChange?: (text: string) => void };
        const originalOnChange = editorAny.onChange;
        editorAny.onChange = (text: string) => {
            originalOnChange?.(text);
            if (!config.history.saveDrafts) return;

            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (text.trim() && text !== lastDraftText && log) {
                    log.record(text, false);
                    lastDraftText = text;
                }
            }, config.history.debounceMs);
        };
    };

    pi.on('session_start', async (_event, context) => {
        ctx = context;
        // after pi has installed the resolved keybindings, so the built-in's
        // other keys survive the release. takes effect on the next start.
        if (SEARCH_KEY) releaseKey('tui.editor.cursorRight', SEARCH_KEY);
        store = PersistedState.open(
            { name: STATE_NAME, scope, parse: parseHistoryState },
            { cwd: context.cwd, sessionId: context.sessionManager.getSessionId() },
        );
        log = new HistoryLog({
            initial: store.read() ?? null,
            maxEntries: config.history.maxEntries,
            onChange: persist,
        });

        // patch the editor's onChange for debounced capture
        const editor = (context.ui as unknown as { editor?: InstanceType<typeof Editor> }).editor;
        if (editor) patchOnChange(editor);
    });

    pi.on('session_shutdown', async () => {
        // capture any unsent draft before exit
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        const editor = (ctx?.ui as unknown as { editor?: InstanceType<typeof Editor> }).editor;
        if (editor) captureDraft(editor);
    });

    function makeItem(entry: HistoryEntry): SelectItem {
        return {
            value: String(entry.id),
            label: `${entry.sent ? '' : '(unsent) '}${preview(entry.text)}`,
            description: age(entry.at),
        };
    }

    type PickerResult =
        | { readonly kind: 'select'; readonly id: HistoryEntryId }
        | { readonly kind: 'delete'; readonly id: HistoryEntryId; readonly index: number }
        | { readonly kind: 'undo' }
        | { readonly kind: 'cancel' };

    // one showing of the picker. delete/undo reopen it since SelectList has no setter.
    const showPicker = (
        context: ExtensionContext,
        entries: readonly HistoryEntry[],
        cursor: number,
        canUndo: boolean,
    ) =>
        context.ui.custom<PickerResult>((tui: TUI, theme: Theme, _kb: unknown, done: (r: PickerResult) => void) => {
            const items = entries.map(makeItem);
            const listTheme: SelectListTheme = {
                selectedPrefix: (t: string) => theme.fg('accent', t),
                selectedText: (t: string) => theme.fg('accent', t),
                description: (t: string) => theme.fg('muted', t),
                scrollInfo: (t: string) => theme.fg('dim', t),
                noMatch: (t: string) => theme.fg('warning', t),
            };

            const list = new SelectList(items, Math.min(items.length, 12), listTheme);
            list.setSelectedIndex(cursor);
            list.onSelect = (selected) => done({ kind: 'select', id: Number(selected.value) as HistoryEntryId });
            list.onCancel = () => done({ kind: 'cancel' });

            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
            container.addChild(new Text(theme.fg('accent', theme.bold(`prompt history (${items.length})`)), 1, 0));
            container.addChild(list);
            const keys = ['up/down move', 'enter select', 'd delete'];
            if (canUndo) keys.push('u undo');
            keys.push('esc cancel');
            container.addChild(new Text(theme.fg('dim', keys.join(', ')), 1, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

            return {
                render: (w: number) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data: string) => {
                    if (matchesKey(data, KEY_DELETE)) {
                        const selected = list.getSelectedItem();
                        if (selected) {
                            const id = Number(selected.value) as HistoryEntryId;
                            const index = entries.findIndex((e) => e.id === id);
                            done({ kind: 'delete', id, index });
                        }
                        return;
                    }
                    if (canUndo && matchesKey(data, KEY_UNDO)) {
                        done({ kind: 'undo' });
                        return;
                    }
                    list.handleInput(data);
                    tui.requestRender();
                },
            };
        });

    // the matches around the cursor, one line each, with the hit marked. the
    // window follows the cursor so a match far down the log is still shown.
    function searchRows(width: number, view: SearchView, theme: Theme): string[] {
        if (view.current === null) {
            return [` ${theme.fg('warning', view.query ? 'no match' : 'no prompt history')}`];
        }
        const last = Math.max(0, view.matches.length - SEARCH_ROWS);
        const first = Math.max(0, Math.min(view.index - Math.floor(SEARCH_ROWS / 2), last));
        return view.matches.slice(first, first + SEARCH_ROWS).map((entry, row) => {
            const at = first + row;
            const when = age(entry.at);
            const budget = Math.max(16, width - when.length - 8);
            const window = matchWindow(entry.text, view.query, budget);
            const hit = window.text.slice(window.start, window.start + window.length);
            const text =
                window.start === -1
                    ? window.text
                    : window.text.slice(0, window.start) +
                      theme.fg('accent', theme.bold(hit)) +
                      window.text.slice(window.start + window.length);
            const marker = at === view.index ? theme.fg('accent', '>') : ' ';
            const draft = entry.sent ? '' : theme.fg('dim', '(unsent) ');
            return ` ${marker} ${draft}${text}  ${theme.fg('muted', when)}`;
        });
    }

    // one showing of the incremental search. resolves with the entry to put in
    // the editor, or null when the search is abandoned.
    const showSearch = (context: ExtensionContext, search: ReverseSearch) =>
        context.ui.custom<HistoryEntry | null>((tui: TUI, theme: Theme, _kb: unknown, done: (r: HistoryEntry | null) => void) => {
            let view = search.view;
            const title = new Text('', 1, 0);
            const rows = {
                render: (width: number) => searchRows(width, view, theme),
                invalidate: () => {},
            };

            const paint = () => {
                const count = view.current === null ? '0' : `${view.index + 1}/${view.matches.length}`;
                title.setText(
                    `${theme.fg('accent', theme.bold('search history'))} ${theme.fg('muted', `(${count})`)}\n` +
                        `${theme.fg('dim', 'find:')} ${view.query}`,
                );
                tui.requestRender();
            };

            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
            container.addChild(title);
            container.addChild(rows);
            container.addChild(
                new Text(
                    theme.fg(
                        'dim',
                        ['up/down move', 'enter take', `${SEARCH_KEY} older`, 'ctrl+u clear', 'esc cancel'].join(', '),
                    ),
                    1,
                    0,
                ),
            );
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
            paint();

            const older: readonly KeyId[] = [...SEARCH_KEY_OLDER, SEARCH_KEY];

            return {
                render: (width: number) => container.render(width),
                invalidate: () => container.invalidate(),
                handleInput: (data: string) => {
                    if (SEARCH_KEY_CANCEL.some((k) => matchesKey(data, k))) {
                        done(null);
                        return;
                    }
                    if (matchesKey(data, SEARCH_KEY_ACCEPT)) {
                        done(view.current);
                        return;
                    }
                    if (older.some((k) => matchesKey(data, k))) {
                        view = search.older();
                        paint();
                        return;
                    }
                    if (SEARCH_KEY_NEWER.some((k) => matchesKey(data, k))) {
                        view = search.newer();
                        paint();
                        return;
                    }
                    if (matchesKey(data, SEARCH_KEY_CLEAR)) {
                        view = search.setQuery('');
                        paint();
                        return;
                    }
                    if (matchesKey(data, SEARCH_KEY_BACKSPACE)) {
                        view = search.setQuery(view.query.slice(0, -1));
                        paint();
                        return;
                    }
                    // anything else printable extends the query. an escape
                    // sequence (a key rho does not handle) is ignored rather
                    // than typed, since its bytes are not what was pressed.
                    if (data.startsWith('\x1b') || /[\x00-\x1f\x7f]/.test(data)) return;
                    view = search.setQuery(view.query + data);
                    paint();
                },
            };
        });

    const openSearch = async (context: ExtensionContext) => {
        if (!log) {
            context.ui.notify('prompt history is disabled ([history] persist = "off")');
            return;
        }
        const search = new ReverseSearch(log.all());
        const typed = (context.ui.getEditorText() ?? '').trim();
        if (typed && !typed.includes('\n') && typed.length <= seedLimit()) search.setQuery(typed);
        const entry = await showSearch(context, search);
        if (entry) context.ui.setEditorText(entry.text);
    };

    if (SEARCH_KEY) {
        pi.registerShortcut(SEARCH_KEY, {
            description: 'search prompt history',
            handler: openSearch,
        });
    }

    pi.registerCommand('history', {
        description: 'browse and search prompt history',
        handler: async (_args: string, context: ExtensionContext) => {
            if (!log) {
                context.ui.notify('prompt history is disabled ([history] persist = "off")');
                return;
            }

            // undo stack for deletions within this picker session
            const undoStack: HistoryEntry[] = [];
            let cursor = 0;

            for (;;) {
                const entries = log.all();
                if (entries.length === 0) {
                    context.ui.notify('no prompt history');
                    return;
                }

                const result = await showPicker(
                    context,
                    entries,
                    Math.min(cursor, entries.length - 1),
                    undoStack.length > 0,
                );

                if (result.kind === 'cancel') return;

                if (result.kind === 'select') {
                    const entry = entries.find((e) => e.id === result.id);
                    if (entry) context.ui.setEditorText(entry.text);
                    return;
                }

                if (result.kind === 'delete') {
                    const entry = entries.find((e) => e.id === result.id);
                    if (entry) {
                        undoStack.push(entry);
                        log.remove(result.id);
                    }
                    cursor = result.index;
                    continue;
                }

                if (result.kind === 'undo') {
                    const entry = undoStack.pop();
                    if (entry) {
                        // re-add to log (record deduplicates, so we insert directly)
                        log.restore(entry);
                    }
                    continue;
                }
            }
        },
    });
}
