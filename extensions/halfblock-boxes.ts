// monkey-patch Box.prototype.render to use half-block edges.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Box, Spacer } from '@earendil-works/pi-tui';

const LOWER_HALF = '\u2584';
const UPPER_HALF = '\u2580';

function bgFnToFg(bgFn: ((s: string) => string) | undefined): string | null {
    if (!bgFn) return null;
    try {
        const sample = bgFn(' ');
        const m24 = sample.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
        if (m24) return `\x1b[38;2;${m24[1]};${m24[2]};${m24[3]}m`;
        const m256 = sample.match(/\x1b\[48;5;(\d+)m/);
        if (m256) return `\x1b[38;5;${m256[1]}m`;
    } catch { /* */ }
    return null;
}

function halfBlockLine(char: string, width: number, fgColor: string): string {
    return `${fgColor}${char.repeat(width)}\x1b[39m`;
}

const origRender = Box.prototype.render;

Box.prototype.render = function (this: any, width: number): string[] {
    const lines: string[] = origRender.call(this, width);
    const paddingY: number = this.paddingY ?? 1;
    if (paddingY === 0 || lines.length < paddingY * 2 + 1) return lines;

    const fg = bgFnToFg(this.bgFn);
    if (!fg) return lines;

    // replace top padding lines with lower-half-blocks
    for (let i = 0; i < paddingY; i++) {
        lines[i] = halfBlockLine(LOWER_HALF, width, fg);
    }
    // replace bottom padding lines with upper-half-blocks
    for (let i = 0; i < paddingY; i++) {
        lines[lines.length - 1 - i] = halfBlockLine(UPPER_HALF, width, fg);
    }
    return lines;
};

// spacers between boxes become redundant: the half-block edges
// already provide visual separation. zero them out.
const origSpacerRender = Spacer.prototype.render;
Spacer.prototype.render = function (_width: number): string[] {
    return [];
};

export default function (_pi: ExtensionAPI) {}
