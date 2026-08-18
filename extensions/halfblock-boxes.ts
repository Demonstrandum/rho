// half-block edges on tool boxes, and no dead space around them.
//
// three patches, each as narrow as the effect needs:
//  1. Box.render          - the paddingY blank lines become half-height blocks.
//  2. ToolExecutionComponent.render - drops the blank lines the tool row adds
//     around itself (its leading Spacer(1) and the self-render path's "").
//  3. Container.render    - where a tool row is immediately followed by an
//     assistant message, drops that message's leading blank line. assistant
//     messages open with a Spacer(1), which is wanted after a user bubble and
//     redundant after a half-block edge, so it is decided by adjacency rather
//     than removed outright.
import {
    AssistantMessageComponent,
    ToolExecutionComponent,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { Box, Container } from '@earendil-works/pi-tui';

const LOWER_HALF = '\u2584';
const UPPER_HALF = '\u2580';

// CSI colour runs and OSC sequences (shell-integration zone markers) both
// occupy no columns, so a line is blank when only those remain.
const CSI = /\x1b\[[0-9;]*m/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function isBlank(line: string): boolean {
    return line.replace(CSI, '').replace(OSC, '').trim() === '';
}

// the control characters on a dropped line (an OSC133 zone marker rides on the
// assistant message's first line) must survive onto the line that replaces it.
function controlsOnly(line: string): string {
    return line.replace(/[^\x1b\x07\[\]0-9;m\\]/g, '').length > 0
        ? (line.match(OSC)?.join('') ?? '')
        : '';
}

// the half-blocks are drawn in the box's own background colour as a foreground
// colour, so half the cell is box-coloured and half is terminal background.
function bgFnToFg(bgFn: ((s: string) => string) | undefined): string | null {
    if (!bgFn) return null;
    try {
        const sample = bgFn(' ');
        const m24 = sample.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
        if (m24) return `\x1b[38;2;${m24[1]};${m24[2]};${m24[3]}m`;
        const m256 = sample.match(/\x1b\[48;5;(\d+)m/);
        if (m256) return `\x1b[38;5;${m256[1]}m`;
    } catch { /* bgFn throws on an unknown theme key */ }
    return null;
}

function halfBlockLine(char: string, width: number, fgColor: string): string {
    return `${fgColor}${char.repeat(width)}\x1b[39m`;
}

// 1. Box: paddingY blank lines -> half-height blocks.
const origBoxRender = Box.prototype.render;

Box.prototype.render = function (this: any, width: number): string[] {
    // copy: the original returns its internal cache array by reference.
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

// 2. tool rows: drop the blank lines they wrap themselves in.
const origToolRender = ToolExecutionComponent.prototype.render;

ToolExecutionComponent.prototype.render = function (this: any, width: number): string[] {
    const lines: string[] = [...origToolRender.call(this, width)];
    while (lines.length > 0 && isBlank(lines[0])) lines.shift();
    while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
    return lines;
};

// 3. tool row -> assistant message: drop the message's leading blank line.
const origContainerRender = Container.prototype.render;

Container.prototype.render = function (this: any, width: number): string[] {
    const children: any[] = this.children ?? [];
    const out: string[] = [];

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        let childLines: string[] = child.render(width);

        const afterToolRow = i > 0 && children[i - 1] instanceof ToolExecutionComponent;
        if (afterToolRow && child instanceof AssistantMessageComponent) {
            childLines = [...childLines];
            let carried = '';
            while (childLines.length > 1 && isBlank(childLines[0])) {
                carried += controlsOnly(childLines[0]);
                childLines.shift();
            }
            if (carried !== '' && childLines.length > 0) {
                childLines[0] = carried + childLines[0];
            }
        }

        for (const line of childLines) out.push(line);
    }
    return out;
};

export default function (_pi: ExtensionAPI) {}
