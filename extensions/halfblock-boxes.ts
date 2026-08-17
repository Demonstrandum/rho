// monkey-patch Box.prototype.render to use half-block edges instead of
// blank padding lines. preserves all built-in rendering (tool labels,
// args, syntax highlighting, diffs). every component that uses Box
// (tools, user messages, custom messages) gets the treatment.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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

export default async function (_pi: ExtensionAPI) {
    // find the Box class from pi's own pi-tui instance.
    // rho has a local devDependency copy (0.80.7); pi uses a global one (0.84.2).
    // patching the wrong copy does nothing. resolve from pi-coding-agent's
    // node_modules so we get the same instance pi's components use.
    // get the Box class. inside pi's process, this should resolve to
    // pi's own pi-tui since pi loaded the module first.
    const { Box } = await import('@earendil-works/pi-tui');
    if (!Box?.prototype?.render) return;

    // verify we got the right one by checking if any existing Box
    // instance is an instanceof this Box. if not, the patch won't work.
    // (this is a no-op check; the patch still applies regardless.)

    const origRender = Box.prototype.render;

    Box.prototype.render = function (this: any, width: number): string[] {
        const realPaddingY: number = this.paddingY ?? 1;
        if (realPaddingY === 0) return origRender.call(this, width);

        const fg = bgFnToFg(this.bgFn);
        if (!fg) return origRender.call(this, width);

        // zero out paddingY so the original render produces no blank lines
        this.paddingY = 0;
        this.invalidateCache();
        const lines: string[] = origRender.call(this, width);
        this.paddingY = realPaddingY;
        this.invalidateCache();

        if (lines.length === 0) return lines;

        // add half-block edges
        lines.unshift(halfBlockLine(LOWER_HALF, width, fg));
        lines.push(halfBlockLine(UPPER_HALF, width, fg));
        return lines;
    };
}
