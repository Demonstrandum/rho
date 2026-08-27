import { test, expect } from 'bun:test';
import { Image, setCapabilities } from '@earendil-works/pi-tui';
import { trimBlankEdges } from '../extensions/halfblock-boxes';

// a kitty placement is one escape sequence followed by (rows - 1) empty lines.
// those empty lines are the height the terminal draws over, so trimming them
// leaves the transcript shorter than the picture and the next rows land on top
// of it.
function imageBlock(): string[] {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const image = new Image('', 'image/png', { fallbackColor: (s) => s }, {}, { widthPx: 640, heightPx: 537 });
    return image.render(80);
}

test('blank edges go when the block is only text', () => {
    expect(trimBlankEdges(['', '  ', 'tool output', ''])).toEqual(['tool output']);
});

test('a colour-only line counts as blank', () => {
    expect(trimBlankEdges(['\x1b[38;5;240m   \x1b[39m', 'x'])).toEqual(['x']);
});

test('an image keeps every reserved row', () => {
    const block = imageBlock();
    expect(block.length).toBeGreaterThan(1);
    expect(trimBlankEdges(block)).toEqual(block);
});

test('an image inside a padded block keeps its rows', () => {
    const block = ['', ...imageBlock(), ''];
    expect(trimBlankEdges(block)).toEqual(block);
});

test('the row count survives a trim, which is what stops the overlap', () => {
    const block = imageBlock();
    expect(trimBlankEdges(block).length).toBe(block.length);
});
