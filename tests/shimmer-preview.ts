// visual inspection harness for the spinner shimmer: pick a maxim and watch the
// live sweep + spinner render in your own terminal. this is not an assertion
// test (it never exits on its own); run it, eyeball it, ctrl-c to quit.
//
//   bun tests/shimmer-preview.ts            # list maxims, then animate a random one
//   bun tests/shimmer-preview.ts 48         # animate maxim #48 (the emoji one)
//   bun tests/shimmer-preview.ts serving    # animate the first maxim matching "serving"
//   bun tests/shimmer-preview.ts --list     # just print the numbered maxim list
//
// override the sweep endpoints (r,g,b) via env if you want to match a theme:
//   SHIMMER_BASE=128,128,128 SHIMMER_ACCENT=80,200,255 bun tests/shimmer-preview.ts 48

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { colorSweep, playFrames, toFrames } from '../extensions/spinner';
import { ansiFg, type Rgb } from '../extensions/lib/utils';

const here = join(import.meta.dir, '..', 'extensions', 'assets');

function loadLines(path: string): string[] {
    return readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith(';'));
}

function parseRgb(value: string | undefined, fallback: Rgb): Rgb {
    if (!value) return fallback;
    const parts = value.split(',').map((n) => Number(n.trim()));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return fallback;
    return [parts[0], parts[1], parts[2]];
}

const maxims = loadLines(join(here, 'maxims.txt'));
const spinners = JSON.parse(readFileSync(join(here, 'spinners.json'), 'utf8')) as Record<
    string,
    { category: string; interval: number; frames: string | string[]; animation?: 'repeat' | 'pulse' }
>;

const BASE = parseRgb(process.env.SHIMMER_BASE, [128, 128, 128]);
const ACCENT = parseRgb(process.env.SHIMMER_ACCENT, [90, 205, 255]);
const SPINNER_COLOR: Rgb = [90, 205, 255];
const SHIMMER_MS = 80;
const DOTS_MAX = 3;

function printList(): void {
    for (const [i, m] of maxims.entries()) console.log(`${String(i).padStart(3)}  ${m}`);
}

function selectMaxim(query: string | undefined): string {
    if (query === undefined) return maxims[Math.floor(Math.random() * maxims.length)];
    const asIndex = Number(query);
    if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < maxims.length) return maxims[asIndex];
    const match = maxims.find((m) => m.toLowerCase().includes(query.toLowerCase()));
    if (!match) {
        console.error(`no maxim matches ${JSON.stringify(query)}. run with --list to see them.`);
        process.exit(1);
    }
    return match;
}

// a chinese-category spinner for the indicator, same source the extension uses.
function pickSpinner(): string[] {
    const chinese = Object.values(spinners).filter((s) => s.category === 'chinese');
    const pool = chinese.length > 0 ? chinese : Object.values(spinners);
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    return playFrames(toFrames(chosen.frames), chosen.animation ?? 'repeat');
}

const arg = process.argv[2];
if (arg === '--list') {
    printList();
    process.exit(0);
}

const maxim = selectMaxim(arg);
const spinnerFrames = pickSpinner();

console.log('maxim:  ' + maxim);
console.log('base:   ' + BASE.join(',') + '   accent: ' + ACCENT.join(','));
console.log('ctrl-c to quit\n');

let frame = 0;
process.stdout.write('\x1b[?25l'); // hide cursor
const timer = setInterval(() => {
    const glyph = spinnerFrames[frame % spinnerFrames.length];
    const dots = '.'.repeat(Math.floor(frame) % (DOTS_MAX + 1));
    const line =
        ansiFg(SPINNER_COLOR) + glyph + '\x1b[0m ' +
        colorSweep(maxim, frame, BASE, ACCENT) + ansiFg(BASE) + dots + '\x1b[0m';
    process.stdout.write('\r\x1b[K' + line);
    frame++;
}, SHIMMER_MS);

const quit = () => {
    clearInterval(timer);
    process.stdout.write('\x1b[?25h\n'); // show cursor
    process.exit(0);
};
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
