#!/usr/bin/env bun
// mockup: compare full-padding boxes vs half-block edge boxes

const cols = process.stdout.columns || 80;

// ANSI helpers
const reset = '\x1b[0m';
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;
const dim = '\x1b[2m';
const bold = '\x1b[1m';

// box colors (dark muted backgrounds like tool call boxes)
const boxes = [
    { label: 'bash', bg: [30, 30, 40] as const, fg: [180, 180, 200] as const },
    { label: 'edit', bg: [25, 35, 25] as const, fg: [150, 200, 150] as const },
    { label: 'read', bg: [35, 30, 25] as const, fg: [200, 180, 150] as const },
];

// unicode half blocks
const UPPER_HALF = '\u2580'; // top half filled (▀)
const LOWER_HALF = '\u2584'; // bottom half filled (▄)

function padLine(text: string, bgColor: readonly [number, number, number]): string {
    const [r, g, b] = bgColor;
    // pad to full width with background color
    return `${bg(r, g, b)}${text}${' '.repeat(Math.max(0, cols - stripAnsi(text).length))}${reset}`;
}

function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function halfBlockTop(bgColor: readonly [number, number, number]): string {
    const [r, g, b] = bgColor;
    // lower half filled with box color, upper half is terminal bg
    return `${fg(r, g, b)}${LOWER_HALF.repeat(cols)}${reset}`;
}

function halfBlockBottom(bgColor: readonly [number, number, number]): string {
    const [r, g, b] = bgColor;
    // upper half filled with box color, lower half is terminal bg
    return `${fg(r, g, b)}${UPPER_HALF.repeat(cols)}${reset}`;
}

// content lines for a box
function boxContent(box: typeof boxes[0], lines: string[]): string[] {
    const [fr, fg2, fb] = box.fg;
    return lines.map(l => padLine(`  ${fg(fr, fg2, fb)}${l}`, box.bg));
}

const sampleLines = [
    ['$ grep -rn "pattern" src/', '  src/main.ts:42: matched pattern'],
    ['path: src/index.ts', '  oldText: "foo"', '  newText: "bar"'],
    ['path: README.md', '  (42 lines)'],
];

// ── current style: full blank padding lines ────────────────

console.log(`\n${bold}${dim}── current: full padding lines ──${reset}\n`);

for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const content = boxContent(box, sampleLines[i]);
    // top padding (full bg blank line)
    console.log(padLine('', box.bg));
    for (const line of content) console.log(line);
    // bottom padding (full bg blank line)
    console.log(padLine('', box.bg));
    // gap between boxes (uncolored blank line)
    if (i < boxes.length - 1) console.log('');
}

// ── proposed style: half-block edges ───────────────────────

console.log(`\n${bold}${dim}── proposed: half-block edges ──${reset}\n`);

for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const content = boxContent(box, sampleLines[i]);
    // half-block top edge (one line, half height)
    console.log(halfBlockTop(box.bg));
    for (const line of content) console.log(line);
    // half-block bottom edge (one line, half height)
    console.log(halfBlockBottom(box.bg));
}

// ── comparison: back to back ───────────────────────────────

console.log(`\n${bold}${dim}── comparison: adjacent boxes ──${reset}\n`);

console.log(`${dim}current (6 wasted lines):${reset}`);
for (const box of boxes) {
    console.log(padLine('', box.bg));
    console.log(padLine(`  ${fg(...box.fg)}content here`, box.bg));
    console.log(padLine('', box.bg));
    console.log('');
}

console.log(`${dim}proposed (0 wasted lines):${reset}`);
for (const box of boxes) {
    console.log(halfBlockTop(box.bg));
    console.log(padLine(`  ${fg(...box.fg)}content here`, box.bg));
    console.log(halfBlockBottom(box.bg));
}

// ── mixed: half-block with transition between boxes ────────

console.log(`\n${bold}${dim}── proposed: merged transitions ──${reset}\n`);

for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (i === 0) {
        console.log(halfBlockTop(box.bg));
    } else {
        // merged transition: top half = prev box color, bottom half = this box color
        const prev = boxes[i - 1];
        let line = '';
        for (let c = 0; c < cols; c++) {
            line += `${bg(...prev.bg)}${fg(...box.bg)}${LOWER_HALF}`;
        }
        console.log(`${line}${reset}`);
    }
    console.log(padLine(`  ${fg(...box.fg)}content here`, box.bg));
    if (i === boxes.length - 1) {
        console.log(halfBlockBottom(box.bg));
    }
}
