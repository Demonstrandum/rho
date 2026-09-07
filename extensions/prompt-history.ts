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

import {
    DynamicBorder,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from '@earendil-works/pi-coding-agent';
import { Editor, Container, SelectList, Text, type SelectItem, type SelectListTheme, matchesKey, type TUI } from '@earendil-works/pi-tui';
import { HistoryLog, parseHistoryState, type HistoryEntry, type HistoryEntryId, type HistoryState } from './lib/prompt-history';
import { PersistedState, type StateScope } from './lib/state-store';
import { config } from './lib/config';

const STATE_NAME = 'prompt-history';
const PREVIEW_CHARS = 72;
const KEY_DELETE = 'd';

// branded symbol so we can mark editors as seeded without polluting the type
const SEEDED = Symbol('rho-history-seeded');

interface SeededEditor {
    [SEEDED]?: boolean;
}

function persistScope(): StateScope | null {
    const setting = config.history.persist;
    return setting === 'off' ? null : setting;
}

function preview(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 3)}...` : flat;
}

function age(at: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

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

    // store entries by value for lookup after selection
    const entryByValue = new Map<string, HistoryEntry>();

    pi.registerCommand('history', {
        description: 'browse and search prompt history',
        handler: async (_args: string, context: ExtensionContext) => {
            if (!log) {
                context.ui.notify('prompt history is disabled ([history] persist = "off")');
                return;
            }

            const entries = log.all();
            if (entries.length === 0) {
                context.ui.notify('no prompt history');
                return;
            }

            // populate lookup map
            entryByValue.clear();
            for (const entry of entries) {
                entryByValue.set(String(entry.id), entry);
            }

            const items = entries.map(makeItem);

            const result = await context.ui.custom<HistoryEntryId | null>(
                (tui: TUI, theme: Theme, _kb: unknown, done: (result: HistoryEntryId | null) => void) => {
                    const listTheme: SelectListTheme = {
                        selectedPrefix: (t: string) => theme.fg('accent', t),
                        selectedText: (t: string) => theme.fg('accent', t),
                        description: (t: string) => theme.fg('muted', t),
                        scrollInfo: (t: string) => theme.fg('dim', t),
                        noMatch: (t: string) => theme.fg('warning', t),
                    };

                    const list = new SelectList(items, Math.min(items.length, 12), listTheme);
                    list.onSelect = (selected) => {
                        done(Number(selected.value) as HistoryEntryId);
                    };
                    list.onCancel = () => done(null);

                    const container = new Container();
                    container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
                    container.addChild(new Text(theme.fg('accent', theme.bold(`prompt history (${items.length})`)), 1, 0));
                    container.addChild(list);
                    container.addChild(new Text(theme.fg('dim', 'up/down move, enter select, d delete, esc cancel'), 1, 0));
                    container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

                    return {
                        render: (w: number) => container.render(w),
                        invalidate: () => container.invalidate(),
                        handleInput: (data: string) => {
                            if (matchesKey(data, KEY_DELETE)) {
                                const selected = list.getSelectedItem();
                                if (selected) {
                                    const id = Number(selected.value) as HistoryEntryId;
                                    log!.remove(id);
                                    // close picker after delete since we can't update the list
                                    done(null);
                                }
                                return;
                            }
                            list.handleInput(data);
                            tui.requestRender();
                        },
                    };
                },
            );

            if (result !== null) {
                const entry = entryByValue.get(String(result));
                if (entry) {
                    context.ui.setEditorText(entry.text);
                }
            }
        },
    });
}
