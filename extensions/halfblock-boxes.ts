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

// set of bg ANSI sequences that get half-block treatment (tool boxes).
// populated in session_start from theme. boxes with other bg colors
// (user messages, custom messages) keep their original padding.
const toolBgSet = new Set<string>();

function isToolBg(bgFn: ((s: string) => string) | undefined): boolean {
    if (!bgFn || toolBgSet.size === 0) return false;
    try {
        const sample = bgFn(' ');
        const m = sample.match(/\x1b\[48;2;\d+;\d+;\d+m/) ?? sample.match(/\x1b\[48;5;\d+m/);
        return m ? toolBgSet.has(m[0]) : false;
    } catch { return false; }
}

const origRender = Box.prototype.render;

Box.prototype.render = function (this: any, width: number): string[] {
    const lines: string[] = origRender.call(this, width);
    const paddingY: number = this.paddingY ?? 1;
    if (paddingY === 0 || lines.length < paddingY * 2 + 1) return lines;

    if (!isToolBg(this.bgFn)) return lines;

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

// spacers are inside tool-execution components (above the Box).
// with half-block edges they're redundant. zero them out.
Spacer.prototype.render = function (_width: number): string[] {
    return [];
};

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        const theme = ctx.ui.theme as any;
        if (!theme) return;
        // register the tool bg ANSI sequences
        for (const key of ['toolSuccessBg', 'toolErrorBg', 'toolPendingBg']) {
            try {
                const sample = theme.bg(key, ' ');
                const m = sample.match(/\x1b\[48;2;\d+;\d+;\d+m/) ?? sample.match(/\x1b\[48;5;\d+m/);
                if (m) toolBgSet.add(m[0]);
            } catch { /* */ }
        }
    });
}
