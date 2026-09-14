import { describe, expect, test } from 'bun:test';
import { hints, intentOf } from '../extensions/lib/picker';

/**
 * The keys these lists use, in one place.
 *
 * ctrl+c has to be caught before the list sees it, because it is escape's twin
 * in tui.select.cancel: a clear that reaches the list cancels instead. Under
 * the kitty keyboard protocol it arrives as a CSI-u sequence rather than \x03,
 * which is why the comparison is matchesKey and not a byte compare.
 */

const CTRL_C = '\u0003';
const CTRL_C_KITTY = '\u001b[99;5u';

describe('what a keystroke means in a picker', () => {
    test('a key means nothing when the action it would take does not exist', () => {
        expect(intentOf('d', {})).toBeNull();
        expect(intentOf('u', {})).toBeNull();
        expect(intentOf(CTRL_C, {})).toBeNull();
    });

    test('d removes, u undoes, ctrl+c clears, when those are offered', () => {
        const action = { remove: 'stop', undo: true, clear: 'stop all' };
        expect(intentOf('d', action)).toBe('remove');
        expect(intentOf('u', action)).toBe('undo');
        expect(intentOf(CTRL_C, action)).toBe('clear');
    });

    test('ctrl+c is recognised in its kitty form as well as its byte', () => {
        const action = { clear: 'stop all' };
        expect(intentOf(CTRL_C_KITTY, action)).toBe('clear');
    });

    test('anything else belongs to the list', () => {
        const action = { remove: 'stop', undo: true, clear: 'all' };
        for (const key of ['\u001b[A', '\u001b[B', '\r', 'x', ' ']) {
            expect(intentOf(key, action)).toBeNull();
        }
    });
});

describe('the hint line', () => {
    test('names what each key does here, in the order they are pressed', () => {
        expect(hints({ choose: 'connect', remove: 'stop' })).toBe(
            'up/down move, enter connect, d stop, esc cancel',
        );
    });

    test('offers undo only when there is something to undo', () => {
        expect(hints({ remove: 'delete' })).not.toContain('undo');
        expect(hints({ remove: 'delete', undo: true })).toContain('u undo');
    });

    test('a list with no actions still says how to choose and how to leave', () => {
        expect(hints({})).toBe('up/down move, enter select, esc cancel');
    });
});
