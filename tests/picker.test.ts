import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'bun:test';
import { browse, busyRow, hints, intentOf } from '../extensions/lib/tui/picker';

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

    test('a key of the list\'s own comes back as itself', () => {
        const action = {
            remove: 'stop',
            extra: [
                { key: 'x', label: 'forget', id: 'forget', suspends: true } as const,
                { key: 'ctrl+d', label: 'delete', id: 'delete' } as const,
            ],
        };
        expect(intentOf('x', action)).toEqual({ extra: 'forget' });
        expect(intentOf('\u0004', action)).toEqual({ extra: 'delete' });
    });
});

describe('a row with an action running on it', () => {
    test('says what is being done to it, after what it already said', () => {
        const row = busyRow({ value: 'blue', label: 'blue', description: 'running, /srv/blue' }, 'stopping');
        expect(row.description).toBe('running, /srv/blue, stopping...');
        expect(row.label).toBe('blue');
    });

    test('a row with nothing to say says only that', () => {
        expect(busyRow({ value: 'blue', label: 'blue' }, 'deleting').description).toBe('deleting...');
    });
});

/** The list as a caller drives it: the component, and the keys it is sent. */
const harness = () => {
    const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
    const tui = { requestRender: () => {} };
    const held: { component?: { handleInput(data: string): void } } = {};
    const ctx = {
        ui: {
            notify: () => {},
            custom: (factory: (t: unknown, th: unknown, k: unknown, done: (v: unknown) => void) => unknown) =>
                new Promise((settle) => {
                    held.component = factory(tui, theme, {}, settle) as { handleInput(data: string): void };
                }),
        },
    } as unknown as ExtensionContext;
    return { ctx, press: (key: string) => held.component?.handleInput(key) };
};

/** Long enough for an action and the reread of the list that follows it. */
const settled = () => new Promise((wake) => setTimeout(wake, 25));

describe('a list that runs out of rows', () => {
    test('removing the last row closes the picker instead of drawing nothing', async () => {
        let names = ['one', 'two'];
        const { ctx, press } = harness();
        const done = browse(ctx, {
            title: 'sessions',
            items: () => names.map((name) => ({ value: name, label: name })),
            action: () => ({ remove: 'stop' }),
            remove: async (value) => {
                names = names.filter((name) => name !== value);
                return true;
            },
        });
        await settled();
        for (const _ of names.slice()) {
            press('d');
            await settled();
        }
        expect(names).toEqual([]);
        expect(await Promise.race([done, settled().then(() => 'still open')])).toBeNull();
    });

    test('the cursor stays where it is, so a run of removals walks the list', async () => {
        let names = ['one', 'two', 'three'];
        const gone: string[] = [];
        const { ctx, press } = harness();
        const done = browse(ctx, {
            title: 'sessions',
            items: () => names.map((name) => ({ value: name, label: name })),
            action: () => ({ remove: 'stop' }),
            remove: async (value) => {
                gone.push(value);
                names = names.filter((name) => name !== value);
                return true;
            },
        });
        await settled();
        press('d');
        await settled();
        press('d');
        await settled();
        expect(gone).toEqual(['one', 'two']);
        expect(names).toEqual(['three']);
        press('\u001b');
        await done;
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

    test('the word a busy row uses is not the word in the hints', () => {
        expect(hints({ remove: 'stop', removing: 'stopping' })).toContain('d stop');
        expect(hints({ remove: 'stop', removing: 'stopping' })).not.toContain('stopping');
    });
});
