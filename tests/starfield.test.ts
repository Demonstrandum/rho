import { test, expect } from 'bun:test';
import { readRow, writeRow, rgbOf } from '../extensions/lib/tui/cells';
import { DOTS, paintStars, starAt, type Sky } from '../extensions/lib/chrome/starfield';
import { durationMs, paintIgnition, pickStyle } from '../extensions/lib/chrome/ignition';
import { type Rgb, ansiBg, ansiFg } from '../extensions/lib/core/utils';
import { plain, visibleWidth } from '../extensions/lib/core/text';

const BG: Rgb = [30, 30, 40];
const WHITE: Rgb = [255, 255, 255];

const sky = (time: number): Sky => ({ time, visibility: 1, peak: 0.55, density: 5, toward: WHITE });

function field(width: number): string {
    return ansiBg(BG) + ' '.repeat(width) + '\x1b[0m';
}

test('a row reads into cells and writes back to the same text and colours', () => {
    const line = `\x1b[1m${ansiFg([1, 2, 3])}ab\x1b[22m${ansiBg(BG)} 中\x1b]8;;http://x\x07c\x1b]8;;\x07\x1b[0m`;
    const row = readRow(line);
    expect(row.cells.map((c) => c.text)).toEqual(['a', 'b', ' ', '中', 'c']);
    expect(row.cells[3]!.width).toBe(2);
    expect(row.cells[0]!.style.attrs).toEqual(['1']);
    expect(row.cells[2]!.style.attrs).toEqual([]);
    expect(rgbOf(row.cells[2]!.style.bg)).toEqual(BG);
    const again = readRow(writeRow(row));
    expect(again).toEqual(row);
    expect(plain(writeRow(row))).toBe(plain(line));
});

test('the same cell at the same moment always holds the same star', () => {
    for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 40; dx++) {
            expect(starAt(dx, dy, sky(2.5))).toEqual(starAt(dx, dy, sky(2.5)));
        }
    }
});

test('about one cell in `density` ever holds a star, and each twinkles on and off', () => {
    let everLit = 0;
    let everDark = 0;
    for (let dx = 0; dx < 500; dx++) {
        // 7 s covers the longest period.
        const seen = Array.from({ length: 140 }, (_, t) => starAt(dx, 1, sky(t / 20)));
        if (seen.some((s) => s !== undefined)) everLit++;
        if (seen.some((s) => s === undefined)) everDark++;
    }
    expect(everLit).toBeGreaterThan(60);
    expect(everLit).toBeLessThan(140);
    expect(everDark).toBe(500);
});

test('stars land only in blank cells with a truecolor background, never on text or the cursor', () => {
    const width = 60;
    const line = ansiBg(BG) + 'hello' + '\x1b[7m \x1b[27m' + ' '.repeat(width - 6) + '\x1b[0m';
    let painted = 0;
    for (let t = 0; t < 7; t += 0.25) {
        const row = readRow(line);
        if (paintStars(row, 1, sky(t), (x) => x === 7)) painted++;
        expect(row.cells.slice(0, 5).map((c) => c.text).join('')).toBe('hello');
        expect(row.cells[5]!.text).toBe(' ');
        expect(row.cells[7]!.text).toBe(' ');
        for (const cell of row.cells) {
            if ((DOTS as readonly string[]).includes(cell.text)) {
                const fg = rgbOf(cell.style.fg)!;
                expect(fg[0]).toBeGreaterThanOrEqual(BG[0]);
                expect(fg[0]).toBeLessThanOrEqual(Math.round(BG[0] + (255 - BG[0]) * 0.55));
            }
        }
        expect(visibleWidth(writeRow(row))).toBe(width);
    }
    expect(painted).toBeGreaterThan(0);

    const bare = readRow(' '.repeat(width));
    expect(paintStars(bare, 1, sky(3))).toBe(false);
});

test('zero visibility draws nothing', () => {
    const row = readRow(field(80));
    expect(paintStars(row, 0, { ...sky(3), visibility: 0 })).toBe(false);
});

test('the ignition tints the field, edges included, and leaves the text alone', () => {
    const width = 40;
    const edge = ansiFg(BG) + '\u2584'.repeat(width) + '\x1b[39m';
    const text = ansiBg(BG) + ' hi' + ' '.repeat(width - 3) + '\x1b[0m';
    for (const style of ['wave', 'aurora', 'pulse'] as const) {
        const rows = [edge, text, edge].map(readRow);
        const changed = paintIgnition(rows, width, { style, tier: 'max', elapsedMs: durationMs(style, 'max') * 0.3, sparkRow: 1 });
        expect(changed.size).toBeGreaterThan(0);
        expect(plain(writeRow(rows[1]!))).toBe(plain(text));
        const tinted = rows[1]!.cells.some((c) => {
            const bg = rgbOf(c.style.bg)!;
            return bg[0] !== BG[0] || bg[1] !== BG[1] || bg[2] !== BG[2];
        });
        expect(tinted).toBe(true);
    }
});

test('an ultra wave throws its spark at the right end of the first content row', () => {
    const width = 40;
    const text = field(width);
    const glyphs = [950, 1050, 1150].map((ms) => {
        const rows = [readRow(text)];
        paintIgnition(rows, width, { style: 'wave', tier: 'ultra', elapsedMs: ms, sparkRow: 0 });
        return rows[0]!.cells[width - 2]!.text;
    });
    expect(glyphs).toEqual(['\u00b7', '\u2726', '\u2727']);
    const early = [readRow(text)];
    paintIgnition(early, width, { style: 'wave', tier: 'ultra', elapsedMs: 500, sparkRow: 0 });
    expect(early[0]!.cells[width - 2]!.text).toBe(' ');
});

test('a style is never picked twice running while there is another', () => {
    let last = pickStyle(['wave', 'aurora'], undefined);
    for (let i = 0; i < 50; i++) {
        const next = pickStyle(['wave', 'aurora'], last);
        expect(next).not.toBe(last);
        last = next;
    }
    expect(pickStyle(['pulse'], 'pulse')).toBe('pulse');
});
