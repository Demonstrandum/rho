// half-block edges on tool boxes.
//
// two patches:
//  1. Box.render: the paddingY blank lines become half-height block
//     characters (bottom half coloured on top, top half coloured on bottom).
//  2. ToolExecutionComponent.render: strips the leading/trailing blank
//     lines it adds around itself, since the half-block edges already
//     provide that separation. all other spacing (assistant messages,
//     thinking traces, user bubbles) is left exactly as pi renders it.
import { ToolExecutionComponent, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Box } from '@earendil-works/pi-tui';

const LOWER_HALF = '\u2584';
const UPPER_HALF = '\u2580';

// the half-block characters are drawn in the box's background colour as
// a foreground colour, so half the cell is box-coloured and half is
// terminal background.
function bgFnToFg(bgFn: ((s: string) => string) | undefined): string | null {
    if (!bgFn) return null;
    try {
        const sample = bgFn(' ');
        const m24 = sample.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
        if (m24) return `\x1b[38;2;${m24[1]};${m24[2]};${m24[3]}m`;
        const m256 = sample.match(/\x1b\[48;5;(\d+)m/);
        if (m256) return `\x1b[38;5;${m256[1]}m`;
    } catch { /* bgFn may throw on an unknown theme key */ }
    return null;
}

function halfBlockLine(char: string, width: number, fgColor: string): string {
    return `${fgColor}${char.repeat(width)}\x1b[39m`;
}

const origBoxRender = Box.prototype.render;

Box.prototype.render = function (this: any, width: number): string[] {
    // copy: origRender returns its internal cache array by reference.
    const lines: string[] = [...origBoxRender.call(this, width)];
    const paddingY: number = this.paddingY ?? 1;
    if (paddingY === 0 || lines.length < paddingY * 2 + 1) return lines;

    const fg = bgFnToFg(this.bgFn);
    if (!fg) return lines;

    for (let i = 0; i < paddingY; i++) {
        lines[i] = halfBlockLine(LOWER_HALF, width, fg);
    }
    for (let i = 0; i < paddingY; i++) {
        lines[lines.length - 1 - i] = halfBlockLine(UPPER_HALF, width, fg);
    }
    return lines;
};

// tool rows add a Spacer(1) before the box, and the self-render path
// pushes a leading "". drop blank lines at both ends of a tool row only.
const origToolRender = ToolExecutionComponent.prototype.render;

ToolExecutionComponent.prototype.render = function (this: any, width: number): string[] {
    const lines: string[] = [...origToolRender.call(this, width)];
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    return lines;
};

export default function (_pi: ExtensionAPI) {}
