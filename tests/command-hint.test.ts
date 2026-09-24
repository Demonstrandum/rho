import { test, expect } from 'bun:test';
import { overlayHint, placeHint } from '../extensions/lib/chrome/command-hint';
import { type Rgb, ansiBg } from '../extensions/lib/core/utils';
import { plain, visibleWidth } from '../extensions/lib/core/text';

const BG: Rgb = [0, 0, 0];
const FG: Rgb = [200, 200, 200];

const colours = {
    fg: FG,
    fallback: () => BG as Rgb | undefined,
    fade: 10,
    strength: 1,
};

/** a row of `width` spaces, each column stating the background it is painted with. */
function row(width: number, background: (column: number) => Rgb | undefined): string {
    let out = '';
    for (let column = 0; column < width; column++) {
        const rgb = background(column);
        out += (rgb === undefined ? '' : ansiBg(rgb)) + ' ';
    }
    return out;
}

/** the foreground in force at each column that the hint wrote to. */
function levels(written: string): number[] {
    return [...written.matchAll(/38;2;(\d+);\d+;\d+m/g)].map((m) => Number(m[1]));
}

test('the hint is right-aligned inside the field padding', () => {
    const placed = placeHint('/theme [name]', { width: 40, padding: 2, textEnd: 8, gap: 2 });
    expect(placed).toEqual({ start: 38 - 13, text: '/theme [name]' });
});

test('a typed line pushes the head of the hint off the left, by column', () => {
    const placed = placeHint('/remote create <name> <user@host>', {
        width: 40,
        padding: 2,
        textEnd: 20,
        gap: 2,
    });
    // 38 - (20 + 2) columns are left, and the clip takes the head to fit them
    // rather than falling back to the next word boundary: a character the fade
    // has already taken to the background costs nothing to keep.
    expect(placed?.text).toBe('ame> <user@host>');
    expect(placed?.start).toBe(22);
});

test('no hint where there is no room left for one', () => {
    expect(placeHint('/theme [name]', { width: 20, padding: 2, textEnd: 17, gap: 2 })).toBeUndefined();
});

test('the hint goes into the row at the columns it was placed at', () => {
    const placed = { start: 10, text: 'abc' };
    const written = overlayHint(row(20, () => BG), placed, 10, colours);
    if (written === undefined) throw new Error('expected a written row');
    expect(plain(written)).toBe(`${' '.repeat(10)}abc${' '.repeat(7)}`);
    expect(visibleWidth(written)).toBe(20);
});

test('a character fades into the colour the row states under it, not one from the theme', () => {
    // a gradient under the hint: fading towards anything else takes a
    // character through a colour brighter than either end.
    const under = (column: number): Rgb => [column * 10, column * 10, column * 10];
    const placed = { start: 10, text: 'abcd' };
    const written = overlayHint(row(20, under), placed, 10, { ...colours, fade: 1 });
    // at full reach every character is the hint colour, whatever it sits on
    expect(levels(written ?? '')).toEqual([100, 200, 200, 200]);
});

test('a column stating no background falls back, and without one there is no hint', () => {
    const placed = { start: 2, text: 'ab' };
    expect(overlayHint(row(8, () => undefined), placed, 2, colours)).not.toBeUndefined();
    expect(
        overlayHint(row(8, () => undefined), placed, 2, { ...colours, fallback: () => undefined }),
    ).toBeUndefined();
});

test('a character rises out of the background as it stands clear of the text', () => {
    const placed = { start: 10, text: 'abcdefghijkl' };
    const written = overlayHint(row(30, () => BG), placed, 10, colours);
    const rising = levels(written ?? '');
    expect(rising[0]).toBe(0);
    expect(rising.at(-1)).toBe(200);
    for (let i = 1; i < rising.length; i++) expect(rising[i]).toBeGreaterThanOrEqual(rising[i - 1]);
});

test('a hint that runs past the end of the row is not written', () => {
    expect(overlayHint(row(8, () => BG), { start: 6, text: 'abcd' }, 0, colours)).toBeUndefined();
});
