// monkey-patch Box.prototype.render to use half-block edges instead of
// blank padding lines. preserves all built-in rendering (tool labels,
// args, syntax highlighting, diffs). every component that uses Box
// (tools, user messages, custom messages) gets the treatment.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Box, visibleWidth } from '@earendil-works/pi-tui';

const LOWER_HALF = '\u2584';
const UPPER_HALF = '\u2580';

// extract the fg ANSI sequence that matches a bg ANSI sequence.
// bgFn("x") produces "\x1b[48;2;R;G;Bm x \x1b[49m" (or 256-color variant).
// we need "\x1b[38;2;R;G;Bm" for the half-block characters.
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

export default function (_pi: ExtensionAPI) {
    const origRender = Box.prototype.render;

    Box.prototype.render = function (this: any, width: number): string[] {
        // run the original render
        const lines: string[] = origRender.call(this, width);
        if (lines.length === 0) return lines;

        const paddingY: number = this.paddingY ?? 1;
        if (paddingY === 0) return lines;

        const fg = bgFnToFg(this.bgFn);
        if (!fg) return lines; // no bg function, nothing to patch

        // the original output is:
        //   [paddingY blank bg lines] [content lines] [paddingY blank bg lines]
        // replace each top padding line with a lower-half-block line,
        // and each bottom padding line with an upper-half-block line.

        const result = [...lines];

        // top padding: first paddingY lines
        for (let i = 0; i < paddingY && i < result.length; i++) {
            result[i] = halfBlockLine(LOWER_HALF, width, fg);
        }

        // bottom padding: last paddingY lines
        for (let i = 0; i < paddingY && i < result.length; i++) {
            result[result.length - 1 - i] = halfBlockLine(UPPER_HALF, width, fg);
        }

        return result;
    };
}
