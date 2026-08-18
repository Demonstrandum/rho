// input field styling: half-block edges, background fill, and horizontal
// gradient on the editor's border and content rows.
//
// patches CustomEditor.prototype.render (not Editor, so login dialogs and
// selector editors are untouched). the original render produces, in order:
//   [0]           top border        (borderColor('─').repeat or scroll indicator)
//   [1..n]        content rows      (text with padding, no background)
//   [n+1]         bottom border     (same as top, or scroll indicator)
//   [n+2..]       autocomplete rows (when the menu is open)
//
// to reliably find the border rows regardless of autocomplete, we temporarily
// wrap borderColor with a sentinel-emitting function for the duration of the
// original call. every row produced through it carries '\x00', so the two
// border rows self-identify.

import {
    CustomEditor,
    type ExtensionAPI,
    type Theme,
    type ThemeColor,
} from '@earendil-works/pi-coding-agent';
import { Editor } from '@earendil-works/pi-tui';
import { config, type GradientSpec } from './lib/config';
import {
    type Rgb,
    blend,
    ansiFg,
    ansiBg,
    parseFgRgb,
    parseHex,
    themeRgb,
    themeBgRgb,
    rgbToHsl,
    hslToRgb,
    applyHslFilters,
    RESET,
} from './lib/utils';

const LOWER_HALF = '\u2584';
const UPPER_HALF = '\u2580';
const SENTINEL = '\x00';

const { halfBlockEdges, background, gradient, darken, tint, gradientColors, bashColors } = config.input;

// the theme instance is captured on session_start and updated on theme change.
// renders before that (the brief window between extension load and session
// start) fall back to pi's rows untouched.
let activeTheme: Theme | undefined;

function luminance(rgb: Rgb): number {
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

function fieldBgRgb(): Rgb | undefined {
    if (!activeTheme) return undefined;
    const base = themeBgRgb(activeTheme, 'userMessageBg');
    if (!base) return undefined;
    // darken light backgrounds, lighten dark ones, so the field bg sits
    // just off the bubble colour regardless of terminal theme.
    // light backgrounds need a gentler shift to avoid a heavy grey.
    const light = luminance(base) > 128;
    const target: Rgb = light ? [0, 0, 0] : [255, 255, 255];
    const amount = light ? darken * 0.4 : darken;
    return blend(base, target, amount);
}

// resolve a colour spec. forms:
//   ""                  empty, returns undefined
//   "#rrggbb"           hex
//   "border"            theme fg or bg colour name
//   "border@l=80,s*0.4" colour with HSL filters
//   "#3366aa@l+20"      hex with filters
function resolveColour(spec: string): Rgb | undefined {
    if (!spec || !activeTheme) return undefined;

    let colourPart = spec;
    let filters: string[] | undefined;
    const at = spec.indexOf('@');
    if (at !== -1) {
        colourPart = spec.slice(0, at);
        filters = spec.slice(at + 1).split(',');
    }

    let rgb: Rgb | undefined;
    if (colourPart.startsWith('#')) {
        rgb = parseHex(colourPart);
    } else {
        try { rgb = themeRgb(activeTheme, colourPart as ThemeColor); } catch {}
        if (!rgb) { try { rgb = themeBgRgb(activeTheme, colourPart); } catch {} }
    }
    if (!rgb) return undefined;

    if (filters && filters.length > 0) {
        rgb = hslToRgb(applyHslFilters(rgbToHsl(rgb), filters));
    }
    return rgb;
}

interface ResolvedGradient {
    colors: Rgb[];
    positions: number[];
}

function resolveGradient(spec: GradientSpec): ResolvedGradient | undefined {
    const names = Array.isArray(spec) ? spec : spec.colors;
    if (names.length === 0) return undefined;
    const colors: Rgb[] = [];
    for (const s of names) {
        const rgb = resolveColour(s);
        if (!rgb) return undefined;
        colors.push(rgb);
    }
    const positions = Array.isArray(spec)
        ? colors.map((_, i) => colors.length === 1 ? 0 : i / (colors.length - 1))
        : spec.stops;
    return { colors, positions };
}

function gradientAt(g: ResolvedGradient, t: number): Rgb {
    const { colors, positions } = g;
    if (colors.length === 1) return colors[0];
    if (t <= positions[0]) return colors[0];
    if (t >= positions[positions.length - 1]) return colors[colors.length - 1];
    for (let i = 0; i < positions.length - 1; i++) {
        if (t <= positions[i + 1]) {
            const span = positions[i + 1] - positions[i];
            const local = span > 0 ? (t - positions[i]) / span : 0;
            return blend(colors[i], colors[i + 1], local);
        }
    }
    return colors[colors.length - 1];
}

function rgbEqual(a: Rgb, b: Rgb | undefined): boolean {
    return !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

if (halfBlockEdges || background) {
    let cachedWidth = 0;
    let cachedStopsKey = '';
    let cachedTopEdge = '';
    let cachedBottomEdge = '';
    let cachedColBg: string[] = [];

    function rgbHex(rgb: Rgb): string {
        return `${rgb[0]},${rgb[1]},${rgb[2]}`;
    }

    function gradientHalfBlockLine(char: string, width: number, g: ResolvedGradient): string {
        const parts: string[] = [];
        for (let i = 0; i < width; i++) {
            const t = width > 1 ? i / (width - 1) : 0;
            parts.push(ansiFg(gradientAt(g, t)) + char);
        }
        parts.push('\x1b[39m');
        return parts.join('');
    }

    function flatHalfBlockLine(char: string, width: number, fg: Rgb): string {
        return `${ansiFg(fg)}${char.repeat(width)}\x1b[39m`;
    }

    function ensureCache(width: number, g: ResolvedGradient): void {
        const key = g.colors.map(rgbHex).join('|') + '@' + g.positions.join(',');
        if (width === cachedWidth && key === cachedStopsKey) return;

        cachedWidth = width;
        cachedStopsKey = key;

        if (halfBlockEdges) {
            if (gradient === 'edges') {
                cachedTopEdge = gradientHalfBlockLine(LOWER_HALF, width, g);
                cachedBottomEdge = gradientHalfBlockLine(UPPER_HALF, width, g);
            } else {
                const flat = g.colors[g.colors.length - 1];
                cachedTopEdge = flatHalfBlockLine(LOWER_HALF, width, flat);
                cachedBottomEdge = flatHalfBlockLine(UPPER_HALF, width, flat);
            }
        }

        if (background) {
            cachedColBg = [];
            for (let i = 0; i < width; i++) {
                const t = width > 1 ? i / (width - 1) : 0;
                cachedColBg.push(ansiBg(gradientAt(g, t)));
            }
        }
    }

    // matches any escape sequence that occupies zero visible columns:
    //   CSI sequences   \x1b[ ... m   (colours, cursor style)
    //   OSC sequences   \x1b] ... BEL (hyperlinks, title)
    //   APC sequences   \x1b_ ... BEL (pi's CURSOR_MARKER)
    const ESCAPE_RE = /\x1b(?:\[[0-9;]*m|[\]_][^\x07\x1b]*\x07)/y;

    // apply the cached per-column gradient background to a content row.
    // walks the already-escaped string: escape sequences are passed through
    // without advancing the column counter; each visible character gets the
    // bg escape for its column. resets (\x1b[0m) from the cursor highlight
    // are followed by the bg for the current column so the colour survives.
    function wrapWithGradientBg(line: string, colBg: string[]): string {
        let col = 0;
        let out = colBg[0] ?? '';
        let i = 0;
        while (i < line.length) {
            if (line.charCodeAt(i) === 0x1b) {
                ESCAPE_RE.lastIndex = i;
                const m = ESCAPE_RE.exec(line);
                if (m) {
                    const esc = m[0];
                    out += esc;
                    if (esc === RESET) out += colBg[col] ?? '';
                    i += esc.length;
                    continue;
                }
            }
            out += line[i];
            col++;
            if (col < colBg.length) out += colBg[col];
            i++;
        }
        out += RESET;
        return out;
    }

    const origRender = Editor.prototype.render;

    CustomEditor.prototype.render = function (this: CustomEditor, width: number): string[] {
        // add 1 space of internal left padding while in this mode.
        const origPadding = this.getPaddingX();
        this.setPaddingX(origPadding + 1);

        // temporarily wrap borderColor to tag border rows with a sentinel.
        const realBorderColor = this.borderColor;
        this.borderColor = (s: string) => SENTINEL + realBorderColor(s);
        const lines = [...origRender.call(this, width)];
        this.borderColor = realBorderColor;
        this.setPaddingX(origPadding);

        // identify border rows by sentinel presence.
        const borderIndices: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(SENTINEL)) {
                lines[i] = lines[i].replaceAll(SENTINEL, '');
                borderIndices.push(i);
            }
        }

        if (borderIndices.length < 2) return lines;

        const topIdx = borderIndices[0];
        const bottomIdx = borderIndices[borderIndices.length - 1];

        // sample the accent colour from what borderColor currently emits.
        const accentRgb = parseFgRgb(realBorderColor('x'));
        if (!accentRgb) return lines;

        const bgRgb = fieldBgRgb();
        if (!bgRgb) return lines;

        // detect mode by comparing accent to known theme colours, then
        // resolve the config gradient for that mode. unrecognised modes
        // (e.g. individual thinking levels) fall through to a two-stop
        // gradient from the sampled accent to the field bg.
        let grad: ResolvedGradient | undefined;
        if (activeTheme) {
            if (rgbEqual(accentRgb, themeRgb(activeTheme, 'bashMode'))) {
                grad = resolveGradient(bashColors);
            } else if (rgbEqual(accentRgb, themeRgb(activeTheme, 'border'))) {
                grad = resolveGradient(gradientColors);
            }
        }
        if (!grad) grad = { colors: [accentRgb, bgRgb], positions: [0, 1] };

        // tint: blend each resolved stop into the field bg so the
        // gradient reads as a wash, not raw saturation. applied after
        // any per-stop @filters.
        const tinted: ResolvedGradient = {
            colors: grad.colors.map(c => blend(bgRgb, c, tint)),
            positions: grad.positions,
        };

        ensureCache(width, tinted);

        if (halfBlockEdges) {
            lines[topIdx] = cachedTopEdge;
            lines[bottomIdx] = cachedBottomEdge;
        }

        if (background) {
            for (let i = topIdx + 1; i < bottomIdx; i++) {
                lines[i] = wrapWithGradientBg(lines[i], cachedColBg);
            }
        }

        return lines;
    };
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', (_event, ctx) => {
        activeTheme = ctx.ui.theme;
    });
}
