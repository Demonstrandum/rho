#!/usr/bin/env bun
// standalone demo of the shimmer animation from extensions/spinner.ts
// run: bun demo-shimmer.ts

import { colorSweep } from './extensions/spinner';
import { ansiFg, RESET, type Rgb } from './extensions/lib/utils';

const SHIMMER_BAND = 4;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// solid block characters for clear visual inspection
const BLOCKS = '████████████████████████████████';

// colors matching the spinner defaults (muted -> accent)
const BASE: Rgb    = [100, 100, 100];  // dim gray (muted)
const SHIMMER: Rgb = [255, 165, 0];    // orange (accent)

// show the blend t-values for each position
function debugSweep(text: string, frame: number): string {
    const clusters = [...graphemes.segment(text)].map((s) => s.segment);
    const len = clusters.length;
    const pos = frame % len;
    const tValues = clusters.map((_, i) => {
        const linear = Math.abs(i - pos);
        const dist = Math.min(linear, len - linear);
        const t = Math.max(0, 1 - dist / SHIMMER_BAND);
        return t.toFixed(2);
    });
    return tValues.join(' ');
}

function clear() {
    process.stdout.write('\x1b[2J\x1b[H');
}

function hideCursor() {
    process.stdout.write('\x1b[?25l');
}

function showCursor() {
    process.stdout.write('\x1b[?25h');
}

let frame = 0;
const interval = 50; // ms per frame (matches config.spinner.shimmerSpeed default)

function render() {
    clear();
    console.log('shimmer animation demo (ctrl+c to exit)\n');
    console.log(`base:    ${ansiFg(BASE)}████${RESET} rgb(${BASE.join(', ')})`);
    console.log(`shimmer: ${ansiFg(SHIMMER)}████${RESET} rgb(${SHIMMER.join(', ')})`);
    console.log(`band width: ${SHIMMER_BAND} graphemes\n`);
    console.log(`frame ${frame.toString().padStart(3)}:`);
    console.log(colorSweep(BLOCKS, frame, BASE, SHIMMER));
    console.log('\nt-values (blend factor 0.00 = base, 1.00 = shimmer):');
    console.log(debugSweep(BLOCKS, frame));
    frame++;
}

hideCursor();
render();
const timer = setInterval(render, interval);

process.on('SIGINT', () => {
    clearInterval(timer);
    showCursor();
    console.log('\n');
    process.exit(0);
});
