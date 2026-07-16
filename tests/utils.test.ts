import { test, expect } from 'bun:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { zip, choose, themeRgb, blend, ansiFg, RESET, type Rgb } from '../extensions/lib/utils';

// make ansi escapes visible in printed output.
const show = (s: string) => s.replaceAll('\x1b', '\\e');

// a fake theme: truecolor for the named roles, palette-index for anything else.
function fakeTheme(roles: Record<string, Rgb>): Theme {
    return {
        getFgAnsi: (color: string) => {
            const rgb = roles[color];
            return rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '\x1b[38;5;12m';
        },
    } as unknown as Theme;
}

test('zip pairs elementwise off the first array', () => {
    const pairs = zip([1, 2, 3], ['a', 'b', 'c']);
    console.log('zip:', JSON.stringify(pairs));
    expect(pairs).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);

    const three = zip([1, 2], ['a', 'b'], [true, false]);
    console.log('zip3:', JSON.stringify(three));
    expect(three).toEqual([[1, 'a', true], [2, 'b', false]]);
});

test('choose returns a member, and honours degenerate weights', () => {
    const items = ['x', 'y', 'z'];
    const draws = Array.from({ length: 8 }, () => choose(items));
    console.log('choose uniform draws:', draws.join(' '));
    for (const d of draws) expect(items).toContain(d);

    // all weight on one slot is deterministic.
    const first = choose(items, [1, 0, 0]);
    const last = choose(items, [0, 0, 1]);
    console.log('choose weighted [1,0,0] ->', first, '| [0,0,1] ->', last);
    expect(first).toBe('x');
    expect(last).toBe('z');
});

test('blend interpolates and rounds per channel', () => {
    const mid = blend([0, 0, 0], [10, 20, 31], 0.5);
    console.log('blend 0->(10,20,31) @0.5:', JSON.stringify(mid));
    expect(mid).toEqual([5, 10, 16]);
    expect(blend([1, 2, 3], [9, 9, 9], 0)).toEqual([1, 2, 3]);
    expect(blend([1, 2, 3], [9, 9, 9], 1)).toEqual([9, 9, 9]);
});

test('themeRgb reads truecolor, undefined in palette mode', () => {
    const theme = fakeTheme({ accent: [10, 20, 30] });
    const accent = themeRgb(theme, 'accent' as never);
    const muted = themeRgb(theme, 'muted' as never);
    console.log('themeRgb accent:', JSON.stringify(accent), '| muted (palette):', muted);
    expect(accent).toEqual([10, 20, 30]);
    expect(muted).toBeUndefined();
});

test('ansiFg emits a truecolor sgr and RESET is the reset', () => {
    console.log('ansiFg(10,20,30):', show(ansiFg([10, 20, 30])), '| RESET:', show(RESET));
    expect(ansiFg([10, 20, 30])).toBe('\x1b[38;2;10;20;30m');
    expect(RESET).toBe('\x1b[0m');
});
