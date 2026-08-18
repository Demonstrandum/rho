// half-block edges on tool boxes, and no dead space around them.
//
// four independent behaviours, each switched by a key in [render] of
// rho.toml. a patch is only installed when its key is true, so a disabled
// behaviour costs nothing at render time.
//
//  half-blocks           Box.render: the paddingY blank rows become
//                        half-height block characters.
//  tight-tool-rows       ToolExecutionComponent.render: drops the blank lines
//                        the tool row wraps itself in (its leading Spacer(1)
//                        and the self-render path's "").
//  tight-after-tool-rows Container.render: drops an assistant message's
//                        leading blank line when a tool row precedes it.
//                        assistant messages open with a Spacer(1), which is
//                        wanted after a user bubble and redundant after a
//                        half-block edge, so it is decided by adjacency
//                        rather than removed outright.
//  hide-idle-status      Container.render: skips pi's IdleStatus, which parks
//                        two blank rows in the dock whenever the agent is
//                        idle. pi adds it from clearStatusIndicator() gated on
//                        terminal.clearOnShrink, which clear-on-shrink.ts
//                        sets. the rows reserve height so a shrink cannot
//                        leave a stale row, but clearOnShrink already forces a
//                        full redraw on shrink, so they are redundant here.
//                        skipping the child is not the same as clearing the
//                        flag: drop the flag and stale rows come back under
//                        the footer. matched on constructor name because pi
//                        exports neither the class nor a subpath to it.
import {
    AssistantMessageComponent,
    ToolExecutionComponent,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { Box, Container, type Component } from '@earendil-works/pi-tui';
import { config } from './lib/config';

// paddingY and bgFn are `private` in Box's declaration, so reaching them needs a
// cast. naming exactly what is reached keeps it to those two members instead of
// opening the whole receiver up.
interface BoxInternals {
    paddingY: number;
    bgFn?: (text: string) => string;
}

const LOWER_HALF = '\u2584';
const UPPER_HALF = '\u2580';

// CSI colour runs and OSC sequences (shell-integration zone markers) both
// occupy no columns, so a line is blank when only those remain.
const CSI = /\x1b\[[0-9;]*m/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function isBlank(line: string): boolean {
    return line.replace(CSI, '').replace(OSC, '').trim() === '';
}

// an OSC133 zone marker rides on an assistant message's first line, so it has
// to survive onto the line that replaces a dropped one.
function oscOnly(line: string): string {
    return line.match(OSC)?.join('') ?? '';
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

const { halfBlocks, tightToolRows, tightAfterToolRows, hideIdleStatus } = config.render;

if (halfBlocks) {
    const origBoxRender = Box.prototype.render;
    Box.prototype.render = function (this: Box, width: number): string[] {
        const self = this as unknown as BoxInternals;
        // copy: the original returns its internal cache array by reference.
        const lines: string[] = [...origBoxRender.call(this, width)];
        const paddingY: number = self.paddingY ?? 1;
        if (paddingY === 0 || lines.length < paddingY * 2 + 1) return lines;

        const fg = bgFnToFg(self.bgFn);
        if (!fg) return lines;

        for (let i = 0; i < paddingY; i++) {
            lines[i] = halfBlockLine(LOWER_HALF, width, fg);
        }
        for (let i = 0; i < paddingY; i++) {
            lines[lines.length - 1 - i] = halfBlockLine(UPPER_HALF, width, fg);
        }
        return lines;
    };
}

if (tightToolRows) {
    const origToolRender = ToolExecutionComponent.prototype.render;
    ToolExecutionComponent.prototype.render = function (
        this: ToolExecutionComponent,
        width: number,
    ): string[] {
        const lines: string[] = [...origToolRender.call(this, width)];
        while (lines.length > 0 && isBlank(lines[0])) lines.shift();
        while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
        return lines;
    };
}

if (tightAfterToolRows || hideIdleStatus) {
    const origContainerRender = Container.prototype.render;
    Container.prototype.render = function (this: Container, width: number): string[] {
        // Container.children is public, so this needs no cast.
        const children: Component[] = this.children ?? [];
        const out: string[] = [];

        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (hideIdleStatus && child?.constructor?.name === 'IdleStatus') continue;

            let childLines: string[] = child.render(width);

            if (
                tightAfterToolRows &&
                i > 0 &&
                children[i - 1] instanceof ToolExecutionComponent &&
                child instanceof AssistantMessageComponent
            ) {
                childLines = [...childLines];
                let carried = '';
                while (childLines.length > 1 && isBlank(childLines[0])) {
                    carried += oscOnly(childLines[0]);
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
}

export default function (_pi: ExtensionAPI) {}
