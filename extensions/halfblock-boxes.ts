// monkey-patch Box.prototype.render to use half-block edges.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Box } from '@earendil-works/pi-tui';

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

// bg ANSI sequences that get extra blank lines outside (user/custom messages).
const paddedBgSet = new Set<string>();

function extractBgAnsi(bgFn: ((s: string) => string) | undefined): string | null {
    if (!bgFn) return null;
    try {
        const sample = bgFn(' ');
        const m = sample.match(/\x1b\[48;2;\d+;\d+;\d+m/) ?? sample.match(/\x1b\[48;5;\d+m/);
        return m ? m[0] : null;
    } catch { return null; }
}

function needsExtraPadding(bgFn: ((s: string) => string) | undefined): boolean {
    if (paddedBgSet.size === 0) return false;
    const ansi = extractBgAnsi(bgFn);
    return ansi ? paddedBgSet.has(ansi) : false;
}

const origRender = Box.prototype.render;

Box.prototype.render = function (this: any, width: number): string[] {
    const lines: string[] = origRender.call(this, width);
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

    // user/custom message boxes: add blank line above and below
    if (needsExtraPadding(this.bgFn)) {
        lines.unshift('');
        lines.push('');
    }

    return lines;
};



export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        const theme = ctx.ui.theme as any;
        if (!theme) return;
        // register bg colors that get extra blank lines outside
        for (const key of ['userMessageBg', 'customMessageBg']) {
            try {
                const sample = theme.bg(key, ' ');
                const m = sample.match(/\x1b\[48;2;\d+;\d+;\d+m/) ?? sample.match(/\x1b\[48;5;\d+m/);
                if (m) paddedBgSet.add(m[0]);
            } catch { /* */ }
        }
    });
}
