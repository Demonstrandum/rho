// which of the editor's rendered lines are the field, read from the editor.
//
// the editor renders its top border, the content rows, its bottom border, and
// then the autocomplete menu when it is open. input-field.ts replaces the two
// borders in place, so their sentinel is gone by the time an outer patch
// sees the lines; the positions are not, and the menu's height is on the
// editor, set during the render that produced them.

import type { CustomEditor } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

// `tui` is protected and `renderedAutocompleteHeight` private in Editor's
// declaration; naming the two members keeps the cast to them.
interface EditorInternals {
    tui: TUI;
    renderedAutocompleteHeight: number;
}

export interface FieldRows {
    /** index of the top border */
    top: number;
    /** index of the bottom border */
    bottom: number;
}

export function fieldRows(editor: CustomEditor, lines: readonly string[]): FieldRows | undefined {
    const menu = (editor as unknown as EditorInternals).renderedAutocompleteHeight ?? 0;
    const bottom = lines.length - menu - 1;
    return bottom >= 2 ? { top: 0, bottom } : undefined;
}

export function editorTui(editor: CustomEditor): TUI {
    return (editor as unknown as EditorInternals).tui;
}
