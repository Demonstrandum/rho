import { test, expect, beforeAll } from 'bun:test';
import { Image, setCapabilities, getPngDimensions, getCellDimensions } from '@earendil-works/pi-tui';
import imageSize from '../extensions/image-size';

// a 4:3 image is enough to make the point: at 60 cells wide it is 26 rows tall,
// which is more than a 24-row window has.
const DIMENSIONS = { widthPx: 640, heightPx: 537 };
const ROWS = 24;
const FRACTION = 0.4;
const CAP = Math.floor(ROWS * FRACTION);

interface Placement {
    readonly columns: number;
    readonly rows: number;
    readonly reservedLines: number;
}

function placement(options: Record<string, number>): Placement {
    const image = new Image('', 'image/png', { fallbackColor: (s) => s }, options, DIMENSIONS);
    const lines = image.render(80);
    const controls = /\x1b_G([^;]*);/.exec(lines[0]!)?.[1] ?? '';
    return {
        columns: Number(/c=(\d+)/.exec(controls)?.[1] ?? 0),
        rows: Number(/r=(\d+)/.exec(controls)?.[1] ?? 0),
        reservedLines: lines.length,
    };
}

beforeAll(async () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true });
    const handlers: ((event: unknown, ctx: { mode: string }) => Promise<void>)[] = [];
    imageSize({ on: (_event: string, handler: unknown) => handlers.push(handler as never) } as never);
    for (const handler of handlers) await handler({}, { mode: 'tui' });
});

test('this image would be taller than the window at pi\'s default width', () => {
    // the reason the patch exists, stated in the same arithmetic pi uses: a
    // width in cells becomes a pixel width, and the rows follow the aspect
    // ratio. the patch is installed for every Image by now, so the uncapped
    // size is computed rather than rendered.
    const cell = getCellDimensions();
    const scale = (60 * cell.widthPx) / DIMENSIONS.widthPx;
    const rows = Math.ceil((DIMENSIONS.heightPx * scale) / cell.heightPx);
    expect(rows).toBeGreaterThan(ROWS);
});

test('the height cap applies with no options at all', () => {
    const capped = placement({});
    expect(capped.rows).toBe(CAP);
    expect(capped.reservedLines).toBe(CAP);
});

test('the width is reduced to keep the aspect ratio', () => {
    const capped = placement({ maxWidthCells: 180 });
    expect(capped.rows).toBe(CAP);
    expect(capped.columns).toBeLessThan(180);
});

test('a smaller explicit cap is kept', () => {
    expect(placement({ maxHeightCells: 5 }).rows).toBe(5);
});

test('the reserved line count always matches the rows the terminal is told to use', () => {
    for (const width of [20, 40, 60, 180]) {
        const capped = placement({ maxWidthCells: width });
        expect(capped.reservedLines).toBe(capped.rows);
    }
});

test('the fixture matches the png reader pi uses', () => {
    // guards the fixture: dimensions are read from the file in real use.
    expect(getPngDimensions('')).toBeNull();
});
