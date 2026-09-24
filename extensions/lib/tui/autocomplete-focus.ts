// which autocomplete item the reader is looking at.
//
// pi's editor opens a SelectList for its completion menu, and that list has an
// onSelectionChange hook, but the editor sets only onSelect: what is chosen is
// reported, what is merely under the cursor is not. a command whose argument is
// worth previewing (a theme, a model, a branch) needs the second one.
//
// so the editor is patched at the two points where the menu's life changes:
// applyAutocompleteSuggestions, which builds the list and preselects a row, and
// clearAutocompleteUi, which drops it. a watcher is asked whether the menu
// belongs to it, by the editor text rather than by the completion prefix,
// because the prefix of `/theme dar` is `dar` and says nothing about which
// command asked for it.
//
// the patch is installed once per process. /reload replaces this module, and a
// second patch over an already patched prototype would call the first one's
// watchers as well, so the installed state and the watcher list both live on
// globalThis, which the two copies share.

import { Editor, type SelectItem, type SelectList } from '@earendil-works/pi-tui';

export interface FocusWatcher {
    /** true when the open menu is this watcher's, given the editor's text. */
    claims(text: string): boolean;
    /** an item is under the cursor. called for the preselected row too. */
    focus(item: SelectItem): void;
    /** the menu closed. `chosen` is the item applied, or null when it was not. */
    close(chosen: SelectItem | null): void;
}

interface Registry {
    watchers: Set<FocusWatcher>;
    patched: boolean;
}

const REGISTRY = '__rho_autocomplete_focus';

function registry(): Registry {
    const shared = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
    return (shared[REGISTRY] ??= { watchers: new Set(), patched: false });
}

/** the editor members reached: TS-private, plain JS at runtime. */
interface EditorInternals {
    autocompleteList?: SelectList;
    applyAutocompleteSuggestions(suggestions: { prefix: string; items: SelectItem[] }, state: string): void;
    clearAutocompleteUi(): void;
    getText(): string;
}

function install(): void {
    const state = registry();
    if (state.patched) return;
    state.patched = true;

    const proto = Editor.prototype as unknown as EditorInternals;

    /** the watcher that owns the menu this editor currently shows, if any. */
    const owner = (editor: EditorInternals): FocusWatcher | undefined => {
        const text = editor.getText();
        for (const watcher of state.watchers) {
            if (watcher.claims(text)) return watcher;
        }
        return undefined;
    };

    // an editor showing a claimed menu, and the item it applied. held per
    // editor, since a session can build more than one.
    const open = new WeakMap<EditorInternals, FocusWatcher>();
    const chosen = new WeakMap<EditorInternals, SelectItem>();

    const origApply = proto.applyAutocompleteSuggestions;
    proto.applyAutocompleteSuggestions = function (this: EditorInternals, suggestions, listState): void {
        origApply.call(this, suggestions, listState);
        const watcher = owner(this);
        if (watcher === undefined) return;
        const list = this.autocompleteList;
        if (list === undefined) return;
        open.set(this, watcher);
        chosen.delete(this);

        const origSelect = list.onSelect;
        list.onSelect = (item: SelectItem) => {
            chosen.set(this, item);
            origSelect?.(item);
        };
        list.onSelectionChange = (item: SelectItem) => watcher.focus(item);
        // the list opens on a preselected row, and no change event follows it.
        const first = list.getSelectedItem();
        if (first) watcher.focus(first);
    };

    const origClear = proto.clearAutocompleteUi;
    proto.clearAutocompleteUi = function (this: EditorInternals): void {
        const watcher = open.get(this);
        origClear.call(this);
        if (watcher === undefined) return;
        open.delete(this);
        const applied = chosen.get(this) ?? null;
        chosen.delete(this);
        watcher.close(applied);
    };
}

/** watch the completion menu. the returned function stops watching. */
export function watchAutocompleteFocus(watcher: FocusWatcher): () => void {
    install();
    const { watchers } = registry();
    watchers.add(watcher);
    return () => watchers.delete(watcher);
}
