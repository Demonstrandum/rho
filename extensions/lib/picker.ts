/**
 * A list to choose from, with the keys these lists already use.
 *
 * The stash picker and the history picker were the same component written
 * twice, down to the hint line and the reopen-after-delete loop, and a third
 * copy was about to be written for remote sessions. The differences between
 * them are which actions exist and what the rows say.
 *
 * SelectList takes its items at construction and has no setter for them, so an
 * action that changes the list closes the picker and `browse` opens it again at
 * the same cursor. That is where the loop lives, once.
 */

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Container, type KeyId, matchesKey, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';

/**
 * SelectList ignores plain letters, since its filter is only ever set
 * programmatically, so single letters are free to mean something here.
 *
 * ctrl+c is escape's twin in tui.select.cancel and has to be caught before the
 * list sees it, or clearing cancels instead. matchesKey does the comparing
 * because under the kitty keyboard protocol ctrl+c arrives as a CSI-u sequence
 * rather than \x03, and a byte compare misses it.
 */
const KEY_DELETE: KeyId = 'd';
const KEY_UNDO: KeyId = 'u';
const KEY_CLEAR: KeyId = 'ctrl+c';

/** what the rows are, and what may be done to them. */
export interface PickerAction {
    /** 'd' removes the row under the cursor. The word names it in the hints. */
    readonly remove?: string;
    /** 'u' puts back what the last removal took. */
    readonly undo?: boolean;
    /** ctrl+c takes the lot. The word names it in the hints. */
    readonly clear?: string;
    /** what enter does, for the hint line. */
    readonly choose?: string;
}

export type Chosen =
    | { readonly kind: 'chosen'; readonly value: string; readonly index: number }
    | { readonly kind: 'remove'; readonly value: string; readonly index: number }
    | { readonly kind: 'undo' }
    | { readonly kind: 'clear' }
    | { readonly kind: 'cancel' };

/** what a keystroke means here, or null to let the list have it. */
export type Intent = 'remove' | 'undo' | 'clear' | null;

export function intentOf(data: string, action: PickerAction): Intent {
    if (action.clear !== undefined && matchesKey(data, KEY_CLEAR)) return 'clear';
    if (action.undo === true && matchesKey(data, KEY_UNDO)) return 'undo';
    if (action.remove !== undefined && matchesKey(data, KEY_DELETE)) return 'remove';
    return null;
}

/** `up/down move, enter connect, d stop, esc cancel` */
export function hints(action: PickerAction): string {
    const keys = ['up/down move', `enter ${action.choose ?? 'select'}`];
    if (action.remove !== undefined) keys.push(`d ${action.remove}`);
    if (action.clear !== undefined) keys.push(`ctrl+c ${action.clear}`);
    if (action.undo === true) keys.push('u undo');
    keys.push('esc cancel');
    return keys.join(', ');
}

const listTheme = (theme: Theme) => ({
    selectedPrefix: (t: string) => theme.fg('accent', t),
    selectedText: (t: string) => theme.fg('accent', t),
    description: (t: string) => theme.fg('muted', t),
    scrollInfo: (t: string) => theme.fg('dim', t),
    noMatch: (t: string) => theme.fg('warning', t),
});

const VISIBLE_ROWS = 12;

export interface PickerView {
    readonly title: string;
    readonly items: readonly SelectItem[];
    readonly action?: PickerAction;
    readonly cursor?: number;
}

/** One showing of the list. It closes as soon as anything is decided. */
export function showPicker(ctx: ExtensionContext, view: PickerView): Promise<Chosen> {
    const action = view.action ?? {};
    return ctx.ui.custom<Chosen>((tui, theme, _keys, done) => {
        const items = [...view.items];
        const list = new SelectList(items, Math.min(items.length, VISIBLE_ROWS), listTheme(theme));
        list.setSelectedIndex(Math.min(Math.max(view.cursor ?? 0, 0), Math.max(items.length - 1, 0)));
        list.onSelect = (selected) =>
            done({
                kind: 'chosen',
                value: selected.value,
                index: items.findIndex((item) => item.value === selected.value),
            });
        list.onCancel = () => done({ kind: 'cancel' });

        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        container.addChild(new Text(theme.fg('accent', theme.bold(`${view.title} (${items.length})`)), 1, 0));
        container.addChild(list);
        container.addChild(new Text(theme.fg('dim', hints(action)), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

        return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
                const intent = intentOf(data, action);
                if (intent === 'clear') {
                    done({ kind: 'clear' });
                    return;
                }
                if (intent === 'undo') {
                    done({ kind: 'undo' });
                    return;
                }
                if (intent === 'remove') {
                    const selected = list.getSelectedItem();
                    if (selected !== undefined && selected !== null) {
                        done({
                            kind: 'remove',
                            value: selected.value,
                            index: items.findIndex((item) => item.value === selected.value),
                        });
                    }
                    return;
                }
                list.handleInput(data);
                tui.requestRender();
            },
        };
    });
}

/** What a caller has to answer for a list that can be acted on. */
export interface Browsable {
    readonly title: string;
    /** Read afresh on every round: an action changes what is there. */
    items(): readonly SelectItem[] | Promise<readonly SelectItem[]>;
    action?(): PickerAction;
    /** Return true to keep browsing, false or nothing to close. */
    remove?(value: string): boolean | void | Promise<boolean | void>;
    undo?(): boolean | void | Promise<boolean | void>;
    clear?(): boolean | void | Promise<boolean | void>;
    /** What there is to say when there is nothing to show. */
    readonly empty?: string;
}

/**
 * Open the list, act on it, open it again where it was.
 *
 * Returns what was chosen, or null when the person left without choosing.
 */
export async function browse(ctx: ExtensionContext, source: Browsable): Promise<string | null> {
    let cursor = 0;
    for (let round = 0; ; round++) {
        const items = await source.items();
        if (items.length === 0) {
            if (round === 0 && source.empty !== undefined) ctx.ui.notify(source.empty, 'info');
            return null;
        }
        const chosen = await showPicker(ctx, {
            title: source.title,
            items,
            action: source.action?.(),
            cursor: Math.min(cursor, items.length - 1),
        });
        if (chosen.kind === 'cancel') return null;
        if (chosen.kind === 'chosen') return chosen.value;
        if (chosen.kind === 'remove') {
            cursor = chosen.index;
            if ((await source.remove?.(chosen.value)) === false) return null;
            continue;
        }
        if (chosen.kind === 'undo') {
            cursor = 0;
            if ((await source.undo?.()) === false) return null;
            continue;
        }
        cursor = 0;
        if ((await source.clear?.()) === false) return null;
    }
}
