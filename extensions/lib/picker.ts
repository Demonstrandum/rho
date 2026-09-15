/**
 * A list to choose from, with the keys these lists already use.
 *
 * The stash picker and the history picker were the same component written
 * twice, down to the hint line and the reopen-after-delete loop, and a third
 * copy was about to be written for remote sessions. The differences between
 * them are which actions exist and what the rows say.
 *
 * SelectList takes its items at construction and has no setter for them, so a
 * changed list is a new SelectList swapped into the container. The picker
 * itself stays open: an action runs while it is on screen, the row says what is
 * happening to it, and the list is redrawn when the action returns. Closing and
 * reopening the whole overlay for every keystroke is what made a run of stops
 * or deletes flash the screen once per row.
 *
 * An action that needs the terminal to itself -- one that asks a question with
 * ctx.ui.input or ctx.ui.confirm -- says so with `suspends`, and for that one
 * `browse` does close the picker and open it again at the same cursor.
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

/** A key of this list's own: `r` to rename, `s` to stop, whatever it needs. */
export interface ExtraKey {
    readonly key: KeyId;
    /** What it does, in the hint line. */
    readonly label: string;
    /** What comes back when it is pressed. */
    readonly id: string;
    /** What the row says while the action runs. Defaults to the id. */
    readonly busy?: string;
    /** The action asks a question, so the picker closes for it and reopens. */
    readonly suspends?: boolean;
}

/** what the rows are, and what may be done to them. */
export interface PickerAction {
    /** 'd' removes the row under the cursor. The word names it in the hints. */
    readonly remove?: string;
    /** What the row says while that runs. Defaults to the hint word. */
    readonly removing?: string;
    /** 'u' puts back what the last removal took. */
    readonly undo?: boolean;
    /** ctrl+c takes the lot. The word names it in the hints. */
    readonly clear?: string;
    /** what enter does, for the hint line. */
    readonly choose?: string;
    /** keys beyond the three every list has. */
    readonly extra?: readonly ExtraKey[];
}

/** How one opening of the list ended. */
export type Chosen =
    | { readonly kind: 'chosen'; readonly value: string }
    | { readonly kind: 'suspend'; readonly id: string; readonly value: string; readonly index: number }
    | { readonly kind: 'cancel' };

/** what a keystroke means here, or null to let the list have it. */
export type Intent = 'remove' | 'undo' | 'clear' | { readonly extra: string } | null;

export function intentOf(data: string, action: PickerAction): Intent {
    if (action.clear !== undefined && matchesKey(data, KEY_CLEAR)) return 'clear';
    if (action.undo === true && matchesKey(data, KEY_UNDO)) return 'undo';
    if (action.remove !== undefined && matchesKey(data, KEY_DELETE)) return 'remove';
    for (const extra of action.extra ?? []) if (matchesKey(data, extra.key)) return { extra: extra.id };
    return null;
}

/** `up/down move, enter connect, d stop, esc cancel` */
export function hints(action: PickerAction): string {
    const keys = ['up/down move', `enter ${action.choose ?? 'select'}`];
    if (action.remove !== undefined) keys.push(`d ${action.remove}`);
    for (const extra of action.extra ?? []) keys.push(`${extra.key} ${extra.label}`);
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

/** A row with an action running on it, as it is drawn while that happens. */
export function busyRow(item: SelectItem, word: string): SelectItem {
    const parts = [item.description, `${word}...`].filter((part) => part !== undefined && part !== '');
    return { ...item, description: parts.join(', ') };
}

/**
 * One showing of the list, which stays open across the actions taken on it.
 *
 * It returns when a row is chosen, when the list is left, or when a key that
 * has to ask a question is pressed.
 */
function openPicker(
    ctx: ExtensionContext,
    source: Browsable,
    first: readonly SelectItem[],
    start: number,
): Promise<Chosen> {
    const action = source.action?.() ?? {};
    return ctx.ui.custom<Chosen>((tui, theme, _keys, done) => {
        let items = [...first];
        let cursor = Math.min(Math.max(start, 0), Math.max(items.length - 1, 0));
        /** value -> the word for what is being done to it. */
        const pending = new Map<string, string>();
        let closed = false;

        const title = new Text('', 1, 0);
        const container = new Container();

        const build = (): SelectList => {
            const shown = items.map((item) => {
                const word = pending.get(item.value);
                return word === undefined ? item : busyRow(item, word);
            });
            const made = new SelectList(shown, Math.min(Math.max(shown.length, 1), VISIBLE_ROWS), listTheme(theme));
            made.setSelectedIndex(Math.min(cursor, Math.max(shown.length - 1, 0)));
            made.onSelectionChange = (item) => {
                const at = shown.findIndex((row) => row.value === item.value);
                if (at >= 0) cursor = at;
            };
            made.onSelect = (item) => finish({ kind: 'chosen', value: item.value });
            made.onCancel = () => finish({ kind: 'cancel' });
            return made;
        };

        let list = build();

        const finish = (outcome: Chosen): void => {
            if (closed) return;
            closed = true;
            done(outcome);
        };

        const redraw = (): void => {
            if (closed) return;
            const made = build();
            const at = container.children.indexOf(list);
            if (at >= 0) container.children[at] = made;
            list = made;
            title.setText(theme.fg('accent', theme.bold(`${source.title} (${items.length})`)));
            container.invalidate();
            tui.requestRender();
        };

        const refresh = async (): Promise<void> => {
            if (closed) return;
            items = [...(await source.items())];
            if (items.length === 0) {
                finish({ kind: 'cancel' });
                return;
            }
            cursor = Math.min(cursor, items.length - 1);
            redraw();
        };

        /**
         * Run an action on a row without closing the list.
         *
         * The row says what is happening to it and the cursor stays where it
         * is, so the next row can be acted on while this one is still in the
         * air. Two actions on the same row at once would be two stops of one
         * session, so a row that is busy ignores the key.
         */
        const act = (value: string | null, word: string, run: () => boolean | void | Promise<boolean | void>): void => {
            if (value !== null) {
                if (pending.has(value)) return;
                pending.set(value, word);
                redraw();
            }
            void Promise.resolve()
                .then(run)
                .then(async (keep) => {
                    if (value !== null) pending.delete(value);
                    if (keep === false) {
                        finish({ kind: 'cancel' });
                        return;
                    }
                    await refresh();
                })
                .catch(async () => {
                    if (value !== null) pending.delete(value);
                    await refresh();
                });
        };

        title.setText(theme.fg('accent', theme.bold(`${source.title} (${items.length})`)));
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        container.addChild(title);
        container.addChild(list);
        container.addChild(new Text(theme.fg('dim', hints(action)), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

        return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
                const intent = intentOf(data, action);
                if (intent === 'clear') {
                    act(null, '', () => source.clear?.());
                    return;
                }
                if (intent === 'undo') {
                    act(null, '', () => source.undo?.());
                    return;
                }
                if (intent === 'remove') {
                    const selected = list.getSelectedItem();
                    if (selected !== null) {
                        act(selected.value, action.removing ?? action.remove ?? 'removing', () =>
                            source.remove?.(selected.value),
                        );
                    }
                    return;
                }
                if (intent !== null) {
                    const selected = list.getSelectedItem();
                    if (selected === null) return;
                    const key = (action.extra ?? []).find((candidate) => candidate.id === intent.extra);
                    if (key?.suspends === true) {
                        finish({ kind: 'suspend', id: intent.extra, value: selected.value, index: cursor });
                        return;
                    }
                    act(selected.value, key?.busy ?? intent.extra, () => source.extra?.(intent.extra, selected.value));
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
    /** One of this list's own keys was pressed on a row. */
    extra?(id: string, value: string): boolean | void | Promise<boolean | void>;
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
        const chosen = await openPicker(ctx, source, items, Math.min(cursor, items.length - 1));
        if (chosen.kind === 'cancel') return null;
        if (chosen.kind === 'chosen') return chosen.value;
        cursor = chosen.index;
        if ((await source.extra?.(chosen.id, chosen.value)) === false) return null;
    }
}
