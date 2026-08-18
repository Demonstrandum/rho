// park prompts instead of losing them: ctrl+s stashes the editor text, ctrl+r
// pops (and re-pops to cycle), and ctrl+s twice in quick succession opens a
// picker over the whole stack.
//
// all of them are ctrl+letter on purpose. an alt binding is unusable on macOS
// unless the terminal sends option as meta: option+s otherwise types the glyph
// printed on the key instead of reaching pi.
//
// claude code has one ctrl+s slot that pops back after the next send. this keeps
// a stack of any size, and the pop key cycles: the first press parks whatever is
// in the editor and shows the newest entry, each further press (with the text
// untouched) shows the next entry instead of parking another copy, and the cycle
// ends back at the text you started with. the stack is recomputed from a
// snapshot taken when the cycle started, so cycling never reorders it. see
// lib/stash.ts for those rules.

import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, type KeyId, matchesKey, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';
import { Stash, type StashEntry, type StashEntryId, type PopResult } from './lib/stash';
import { actionsBoundTo, ensureKeybinding, type KeybindingId } from './lib/keybindings-store';
import { config } from './lib/config';

const STATUS_ID = 'rho-stash';
// SelectList ignores plain letters (its filter is only set programmatically), so
// 'd' and 'u' are free. ctrl+c is escape's twin in tui.select.cancel, so it is
// intercepted before the list sees it. matchesKey does the comparison because
// under the kitty keyboard protocol ctrl+c arrives as a CSI-u sequence rather
// than \x03, and a raw byte compare misses it (the list then cancels instead).
const KEY_DELETE = 'd';
const KEY_CLEAR = 'ctrl+c';
const KEY_UNDO = 'u';
const KEY_ESCAPE = 'escape';
const PREVIEW_CHARS = 72;
// second ctrl+s within this window opens the picker instead of stashing again.
const DOUBLE_TAP_MS = 500;
// how long the post-clear view stays up before it closes itself.
const CLEARED_LINGER_MS = 600;

function preview(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 3)}...` : flat;
}

function age(at: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
}

function shape(text: string): string {
    const lines = text.split('\n').length;
    return lines > 1 ? `${lines} lines, ${text.length} chars` : `${text.length} chars`;
}

function item(entry: StashEntry, ordinal: number): SelectItem {
    return {
        value: String(entry.id),
        label: `${ordinal}. ${preview(entry.text)}`,
        description: `${age(entry.at)}, ${shape(entry.text)}`,
    };
}

type PickerResult =
    | { readonly kind: 'take'; readonly id: StashEntryId }
    | { readonly kind: 'delete'; readonly id: StashEntryId; readonly index: number }
    | { readonly kind: 'clear' }
    | { readonly kind: 'undo' }
    | { readonly kind: 'cancel' };

const CLAIMED: readonly KeyId[] = ['ctrl+s', 'ctrl+r'];

// the claimed keys also drive built-in actions that live in the model and session
// pickers (app.models.save, app.session.toggleSort, app.session.rename, and
// whatever a later pi release adds). the extension handler wins in the editor and
// the pickers keep their own input, so the only cost is a startup report of the
// shared key. this moves each colliding action to the next key of the rho.toml
// pool that nothing else uses, once, and never over a binding the user chose.
function demoteBuiltins(): void {
    const pool = config.stash.demoteTo as readonly KeyId[];
    if (pool.length === 0) return;

    const colliding: KeybindingId[] = [];
    const inUse = new Set<string>();
    for (const key of CLAIMED) {
        const { ids, keysInUse } = actionsBoundTo(key);
        for (const id of ids) if (!colliding.includes(id)) colliding.push(id);
        for (const k of keysInUse) inUse.add(k);
    }

    // sorted so the same action lands on the same key on every machine.
    const free = pool.filter((k) => !inUse.has(k.toLowerCase()));
    let next = 0;
    for (const id of [...colliding].sort()) {
        const destination = free[next];
        if (destination === undefined) return;
        if (ensureKeybinding(id, destination)) next++;
    }
}

export default function (pi: ExtensionAPI) {
    const stash = new Stash();

    // at session_start, not at load: pi installs the global keybindings manager
    // during startup, and the remap needs the resolved bindings to read.
    pi.on('session_start', async () => {
        demoteBuiltins();
    });

    const showStatus = (ctx: ExtensionContext, cycle?: PopResult) => {
        if (stash.size === 0 && (!cycle || cycle.kind === 'empty')) {
            ctx.ui.setStatus(STATUS_ID, undefined);
            return;
        }
        const where =
            cycle && cycle.kind === 'text'
                ? cycle.position.kind === 'origin'
                    ? ' (start)'
                    : ` (${cycle.position.index + 1}/${cycle.total})`
                : '';
        ctx.ui.setStatus(STATUS_ID, `stash ${stash.size}${where}`);
    };

    const applyPop = (ctx: ExtensionContext, result: PopResult) => {
        if (result.kind === 'empty') {
            ctx.ui.notify('stash is empty', 'info');
            return;
        }
        ctx.ui.setEditorText(result.text);
        showStatus(ctx, result);
    };

    let lastStashAt = 0;

    pi.registerShortcut('ctrl+s', {
        description: 'stash the current prompt (twice: browse the stash)',
        handler: async (ctx) => {
            const now = Date.now();
            const doubleTap = now - lastStashAt < DOUBLE_TAP_MS;
            lastStashAt = now;
            if (doubleTap) {
                lastStashAt = 0;
                await openPicker(ctx);
                return;
            }
            if (!stash.push(ctx.ui.getEditorText() ?? '')) return;
            ctx.ui.setEditorText('');
            showStatus(ctx);
        },
    });

    pi.registerShortcut('ctrl+r', {
        description: 'pop a stashed prompt, or cycle when pressed again',
        handler: async (ctx) => {
            applyPop(ctx, stash.pop(ctx.ui.getEditorText() ?? ''));
        },
    });

    // one showing of the picker. delete reopens it, since SelectList takes its
    // items at construction and exposes no setter for them.
    const showPicker = (ctx: ExtensionContext, entries: readonly StashEntry[], cursor: number, canUndo: boolean) =>
        ctx.ui.custom<PickerResult>((tui, theme, _kb, done) => {
            const items = entries.map((entry, i) => item(entry, i + 1));
            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
            container.addChild(new Text(theme.fg('accent', theme.bold(`stash (${items.length})`)), 1, 0));
            const list = new SelectList(items, Math.min(items.length, 12), {
                selectedPrefix: (t) => theme.fg('accent', t),
                selectedText: (t) => theme.fg('accent', t),
                description: (t) => theme.fg('muted', t),
                scrollInfo: (t) => theme.fg('dim', t),
                noMatch: (t) => theme.fg('warning', t),
            });
            list.setSelectedIndex(cursor);
            list.onSelect = (selected) => done({ kind: 'take', id: Number(selected.value) as StashEntryId });
            list.onCancel = () => done({ kind: 'cancel' });
            container.addChild(list);
            const keys = ['up/down move', 'enter take', 'd delete', 'ctrl+c clear all'];
            if (canUndo) keys.push('u undo');
            keys.push('esc cancel');
            container.addChild(new Text(theme.fg('dim', keys.join(', ')), 1, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
            return {
                render: (w) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                    if (matchesKey(data, KEY_CLEAR)) {
                        done({ kind: 'clear' });
                        return;
                    }
                    if (canUndo && matchesKey(data, KEY_UNDO)) {
                        done({ kind: 'undo' });
                        return;
                    }
                    if (matchesKey(data, KEY_DELETE)) {
                        const selected = list.getSelectedItem();
                        if (selected) {
                            const id = Number(selected.value) as StashEntryId;
                            done({ kind: 'delete', id, index: entries.findIndex((e) => e.id === id) });
                        }
                        return;
                    }
                    list.handleInput(data);
                    tui.requestRender();
                },
            };
        });

    // the picker after a clear: nothing to list, so it says what happened, offers
    // the undo, and closes itself. /stash undo still reaches the same undo after.
    const showCleared = (ctx: ExtensionContext, dropped: number) =>
        ctx.ui.custom<PickerResult>((_tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
            container.addChild(new Text(theme.fg('accent', theme.bold(`stash cleared (${dropped} dropped)`)), 1, 0));
            container.addChild(new Text(theme.fg('dim', 'u undo'), 1, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
            const timer = setTimeout(() => done({ kind: 'cancel' }), CLEARED_LINGER_MS);
            const settle = (result: PickerResult) => {
                clearTimeout(timer);
                done(result);
            };
            return {
                render: (w) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                    if (matchesKey(data, KEY_UNDO)) settle({ kind: 'undo' });
                    else if (matchesKey(data, KEY_ESCAPE) || matchesKey(data, KEY_CLEAR)) settle({ kind: 'cancel' });
                },
            };
        });

    // declaration, not a const: the ctrl+s handler above calls it.
    async function openPicker(ctx: ExtensionContext) {
        let cursor = 0;
        for (let round = 0; ; round++) {
            const entries = stash.list();
            if (entries.length === 0) {
                showStatus(ctx);
                if (round === 0) ctx.ui.notify('stash is empty', 'info');
                return;
            }
            const result = await showPicker(ctx, entries, Math.min(cursor, entries.length - 1), stash.canUndo);
            if (result.kind === 'cancel') return;
            if (result.kind === 'take') {
                applyPop(ctx, stash.take(result.id, ctx.ui.getEditorText() ?? ''));
                return;
            }
            if (result.kind === 'delete') {
                stash.drop(result.id);
                cursor = result.index;
                showStatus(ctx);
                continue;
            }
            if (result.kind === 'undo') {
                stash.undo();
                showStatus(ctx);
                continue;
            }
            const dropped = stash.clear();
            showStatus(ctx);
            const after = await showCleared(ctx, dropped);
            if (after.kind !== 'undo') {
                // the view closes after CLEARED_LINGER_MS, so name the slower route.
                ctx.ui.notify(`dropped ${dropped} stashed prompt(s), /stash undo restores them`, 'info');
                return;
            }
            stash.undo();
            cursor = 0;
            showStatus(ctx);
        }
    }

    pi.registerCommand('stash', {
        description: 'browse the stash (args: clear, undo)',
        getArgumentCompletions: (prefix) => {
            const typed = prefix.trim();
            const args: SelectItem[] = [
                { value: 'clear', label: 'clear', description: 'drop every stashed prompt' },
                { value: 'undo', label: 'undo', description: 'restore the last drop or clear' },
            ];
            const matches = args.filter((a) => a.value.startsWith(typed));
            return matches.length > 0 ? matches : null;
        },
        handler: async (args, ctx) => {
            const arg = args.trim();
            if (arg === 'clear') {
                const dropped = stash.clear();
                showStatus(ctx);
                ctx.ui.notify(
                    dropped === 0 ? 'stash was empty' : `dropped ${dropped} stashed prompt(s), /stash undo restores them`,
                    'info',
                );
                return;
            }
            if (arg === 'undo') {
                const restored = stash.undo();
                showStatus(ctx);
                ctx.ui.notify(restored === null ? 'nothing to undo' : `restored ${restored} stashed prompt(s)`, 'info');
                return;
            }
            await openPicker(ctx);
        },
    });
}
