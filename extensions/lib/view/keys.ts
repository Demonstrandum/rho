/**
 * Which key does what, decided by the front end rather than by the view.
 *
 * An action in `view/model.ts` is a name and a verb: `stop`, `delete`, `open`.
 * Only a front end with a keyboard needs a key for it, and only that front end
 * knows which keys it has already spent. So the binding is computed here, once,
 * from the actions a view declares, and the hint line is computed from the same
 * table: a view cannot end up offering a key it does not answer, which is what
 * happens when the two are written out by hand next to each other.
 *
 * A component may ask for a key. It gets it when nothing already has it, which
 * keeps `d` for delete everywhere it is free without letting one view take a
 * key the surface itself needs.
 */

import type { ViewAction, ViewToggle } from './model';

/** Keys this front end keeps: moving, choosing and leaving are not actions. */
export const RESERVED: readonly string[] = ['up', 'down', 'pageUp', 'pageDown', 'home', 'end', 'enter', 'escape'];

/** Letters an action may be given when it asks for nothing usable. */
const CANDIDATES = 'abcdefghijklmnopqrstuvwxyz0123456789';

export type BoundKind = 'action' | 'toggle';

export interface Binding {
    readonly key: string;
    readonly kind: BoundKind;
    /** the action or toggle id. */
    readonly id: string;
    /** the word shown in the hints. */
    readonly label: string;
}

const usable = (key: string | undefined): key is string =>
    key !== undefined && key !== '' && !RESERVED.includes(key);

/**
 * Bind the actions of a view, in the order they were declared.
 *
 * Declaration order decides who wins a contested key, so a view's own order is
 * its statement of which action matters more. An action that can be given no
 * key at all is left unbound rather than silently dropped: the front end still
 * shows it, and something other than a keystroke has to reach it.
 */
export function bind(
    actions: readonly ViewAction[] = [],
    toggles: readonly ViewToggle[] = [],
    taken: readonly string[] = [],
): readonly Binding[] {
    const spent = new Set<string>([...RESERVED, ...taken]);
    const bindings: Binding[] = [];

    const claim = (id: string, label: string, kind: BoundKind, asked: string | undefined): void => {
        if (usable(asked) && !spent.has(asked)) {
            spent.add(asked);
            bindings.push({ key: asked, kind, id, label });
            return;
        }
        const letters = [...label.toLowerCase(), ...CANDIDATES];
        const free = letters.find((letter) => /[a-z0-9]/.test(letter) && !spent.has(letter));
        if (free === undefined) return;
        spent.add(free);
        bindings.push({ key: free, kind, id, label });
    };

    for (const action of actions) claim(action.id, action.label, 'action', action.key);
    for (const toggle of toggles) claim(toggle.id, toggle.label, 'toggle', toggle.key);
    return bindings;
}

/** `up/down move, enter open, d stop, esc close` */
export function hintLine(bindings: readonly Binding[], choose: string | undefined, movement = 'up/down move'): string {
    const parts = [movement];
    if (choose !== undefined) parts.push(`enter ${choose}`);
    for (const binding of bindings) parts.push(`${binding.key} ${binding.label}`);
    parts.push('esc close');
    return parts.join(', ');
}

/** What a bound key means here, or null when the view does not want it. */
export const boundTo = (bindings: readonly Binding[], key: string): Binding | null =>
    bindings.find((binding) => binding.key === key) ?? null;
