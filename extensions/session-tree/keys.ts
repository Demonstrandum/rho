// which key does what in the edited tree view, as a state machine over key
// identifiers. no components and no session types, so the bindings can be
// tested without a terminal.
//
// pi's tree sends every printable key to its search query, which leaves no
// letter free for a verb and no digit free for a count. the view is modal
// instead: normal mode holds the motions and the verbs, `/` enters search, and
// escape leaves it. what normal mode does not claim is passed to pi's own
// handler, so folding, the filter modes, labels, and paging keep working.
//
// motions take a count the way vi's do: `5k` moves five rows up, `5K` extends
// the selection five rows up. the count is accumulated here and handed to the
// caller with the action, since the rows it counts are the visible ones and
// only the view knows those.

import { parseKey } from '@earendil-works/pi-tui';

export type TreeMode = 'normal' | 'search';

export type Verb = 'delete' | 'summarize' | 'prune' | 'edit' | 'copy';

export type TreeAction =
    | { readonly kind: 'move'; readonly by: number }
    | { readonly kind: 'extend'; readonly by: number }
    | { readonly kind: 'select-toggle' }
    | { readonly kind: 'extend-to'; readonly end: 'root' | 'leaf' }
    | { readonly kind: 'verb'; readonly verb: Verb }
    | { readonly kind: 'undo'; readonly all: boolean }
    | { readonly kind: 'confirm' }
    | { readonly kind: 'escape' }
    | { readonly kind: 'mode'; readonly mode: TreeMode }
    /** consumed here and needing nothing of the view, such as a count digit. */
    | { readonly kind: 'none' }
    /** not ours: pi's own key handling takes it. */
    | { readonly kind: 'passthrough' };

export interface KeyState {
    readonly mode: TreeMode;
    /** digits typed so far, empty when no count is pending. */
    readonly count: string;
}

export const INITIAL_KEYS: KeyState = { mode: 'normal', count: '' };

/** what a digit key reports while shift is held. */
const SHIFTED_DIGITS: Readonly<Record<string, string>> = {
    ')': '0',
    '!': '1',
    '@': '2',
    '#': '3',
    $: '4',
    '%': '5',
    '^': '6',
    '&': '7',
    '*': '8',
    '(': '9',
};

/**
 * an uppercase letter reaches us two ways: as itself on a legacy terminal, and
 * as `shift+<letter>` under the kitty protocol. they are one key.
 *
 * a digit typed while shift is held arrives as its shifted symbol, and a count
 * is usually typed on the way to a shifted arrow, so the symbols count as
 * their digits: shift stays down for `3`, `up`, `up`, and nothing is lost.
 */
function normalise(key: string): string {
    const shiftedLetter = /^shift\+([a-z])$/.exec(key);
    if (shiftedLetter) return shiftedLetter[1]!.toUpperCase();
    const shiftedDigit = /^shift\+([0-9])$/.exec(key);
    if (shiftedDigit) return shiftedDigit[1]!;
    return SHIFTED_DIGITS[key] ?? key;
}

interface Step {
    readonly state: KeyState;
    readonly action: TreeAction;
}

function held(state: KeyState, action: TreeAction): Step {
    return { state: { mode: state.mode, count: '' }, action };
}

/** the count in force for a motion, and one when none was typed. */
export function countOf(state: KeyState): number {
    const parsed = Number.parseInt(state.count, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function step(state: KeyState, data: string): Step {
    const parsed = parseKey(data);
    if (parsed === undefined) return { state, action: { kind: 'passthrough' } };
    const key = normalise(parsed);

    if (state.mode === 'search') {
        if (key === 'escape') return { state: { mode: 'normal', count: '' }, action: { kind: 'mode', mode: 'normal' } };
        if (key === 'enter') return { state: { mode: 'normal', count: '' }, action: { kind: 'mode', mode: 'normal' } };
        return { state, action: { kind: 'passthrough' } };
    }

    const count = countOf(state);
    if (/^[1-9]$/.test(key) || (key === '0' && state.count !== '')) {
        return { state: { mode: 'normal', count: state.count + key }, action: { kind: 'none' } };
    }

    switch (key) {
        case 'j':
        case 'down':
            return held(state, { kind: 'move', by: count });
        case 'k':
        case 'up':
            return held(state, { kind: 'move', by: -count });
        case 'J':
        case 'shift+down':
            return held(state, { kind: 'extend', by: count });
        case 'K':
        case 'shift+up':
            return held(state, { kind: 'extend', by: -count });
        case 'v':
            return held(state, { kind: 'select-toggle' });
        case 'g':
            return held(state, { kind: 'extend-to', end: 'root' });
        case 'G':
            return held(state, { kind: 'extend-to', end: 'leaf' });
        case 'd':
            return held(state, { kind: 'verb', verb: 'delete' });
        case 's':
            return held(state, { kind: 'verb', verb: 'summarize' });
        case 'p':
            return held(state, { kind: 'verb', verb: 'prune' });
        case 'e':
            return held(state, { kind: 'verb', verb: 'edit' });
        case 'y':
            return held(state, { kind: 'verb', verb: 'copy' });
        case 'u':
            return held(state, { kind: 'undo', all: false });
        case 'U':
            return held(state, { kind: 'undo', all: true });
        case '/':
            return { state: { mode: 'search', count: '' }, action: { kind: 'mode', mode: 'search' } };
        case 'enter':
            return held(state, { kind: 'confirm' });
        case 'escape':
            return held(state, { kind: 'escape' });
        default:
            return held(state, { kind: 'passthrough' });
    }
}

/** the key hints the view prints, in the order they are shown. */
export const NORMAL_HINTS: readonly (readonly [string, string])[] = [
    ['j/k', 'move'],
    ['shift+arrows', 'select'],
    ['v', 'hold selection'],
    ['g/G', 'to root/leaf'],
    ['d', 'delete'],
    ['s', 'summarise'],
    ['p', 'prune'],
    ['e', 'edit'],
    ['u', 'undo'],
    ['/', 'search'],
    ['enter', 'go'],
];

export const SEARCH_HINTS: readonly (readonly [string, string])[] = [
    ['type', 'filter'],
    ['enter', 'keep'],
    ['esc', 'normal mode'],
];
