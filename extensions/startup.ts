// replace pi's built-in startup block (logo + key-hint wall + the "[Prompts]"
// style bracketed resource listing) with a compact, bold-inline header topped
// by an animated pi wordmark.
//
// pi renders its own block in core and it is not reformattable in place, so the
// approach is: (1) persist quietStartup=true to suppress the built-in block,
// (2) draw our own via ctx.ui.setHeader().
//
// the header runs a ~2s one-shot intro on session start: a quick fade-in (or,
// 1/3 of the time, a block-by-block build-up), then a diagonal down-right
// shimmer, then the "pi vX" label types out with a blinking cursor. it drives
// its own repaints with a timer + tui.requestRender() and clears the timer once
// settled, so nothing animates after the header scrolls out of view. render() is
// a pure function of elapsed time, so resizes/repaints stay consistent.
//
// resource data comes from the public API: pi.getCommands() distinguishes
// prompts / skills / extension commands by `source`, and ctx.ui.getAllThemes()
// lists themes. there is no API to enumerate the loaded extension *files*, so
// there is no "Extensions" section; the extension-provided slash commands show
// under "commands" instead.

import type { ExtensionAPI, SlashCommandInfo, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { ensureGlobalSetting } from './lib/settings-store';
import { zip, choose, themeRgb, blend, ansiFg, RESET, type Rgb } from './lib/utils';

// a short discoverability hint. keep it minimal; the footer carries model/token
// state, so this only points at the two universal entry points.
const HINT = '/ commands · ! bash';

// pi wordmark, transcribed exactly from the hand-drawn glyph ('#' = filled),
// scaled up with block characters. the drawn shape is deliberately asymmetric.
const GLYPH: readonly number[][] = [
    [1, 1, 1, 0],
    [1, 0, 1, 0],
    [1, 1, 0, 1],
    [1, 0, 0, 1],
];
const SCALE_X = 2;
const SCALE_Y = 1;

const GLYPH_H = GLYPH.length;
const GLYPH_W = Math.max(...GLYPH.map((row) => row.length));
const isFilled = (gr: number, gc: number): boolean => GLYPH[gr]?.[gc] === 1;

class Art {
    lines: string[];
    width: number;
    height: number;

    constructor(lines: string[]) {
        this.lines = lines;
        this.width = Math.max(...lines.map(l => l.length));
        this.height = lines.length;
    }

    get centerRow(): number {
        return Math.floor((this.height - 1) / 2);
    }

    draw(): string[] {
        return this.lines.map((l) => l.padEnd(this.width));
    }

    isFilled(row: number, col: number): boolean {
        return (this.lines[row]?.[col] ?? ' ') !== ' ';
    }
}

// scale the 0/1 glyph matrix into solid block-art lines the Art wrapper owns.
function scaleGlyph(glyph: readonly number[][], scaleX: number, scaleY: number): string[] {
    const width = Math.max(...glyph.map((row) => row.length));
    const lines: string[] = [];
    for (const row of glyph) {
        let line = '';
        for (let col = 0; col < width; col++) {
            line += (row[col] === 0 ? ' ' : '█').repeat(scaleX);
        }
        for (let k = 0; k < scaleY; k++) {
            lines.push(line);
        }
    }
    return lines;
}

const ART = new Art(scaleGlyph(GLYPH, SCALE_X, SCALE_Y));
const LOGO_W = ART.width;
const LOGO_H = ART.height;
const CENTER_ROW = ART.centerRow;

// the shimmer sweeps a bright band along one of four axes, picked per session.
type ShimmerDir = 'ns' | 'ew' | 'nwse' | 'nesw';
const SHIMMER_DIRS: ShimmerDir[] = ['ns', 'ew', 'nwse', 'nesw'];
const SHIMMER_RANGE: Record<ShimmerDir, readonly [number, number]> = {
    ns: [0, LOGO_H - 1],
    ew: [0, LOGO_W - 1],
    nwse: [0, LOGO_W - 1 + (LOGO_H - 1)],
    nesw: [-(LOGO_W - 1), LOGO_H - 1],
};
function shimmerProjection(dir: ShimmerDir, row: number, col: number): number {
    switch (dir) {
        case 'ns': return row;
        case 'ew': return col;
        case 'nwse': return row + col;
        case 'nesw': return row - col;
    }
}

// truecolor rgb shimmer, ported from spinner.ts: blend accent -> highlight per
// cell by a smooth moving band, instead of swapping discrete block glyphs.

function darken(rgb: Rgb, factor: number): Rgb {
    return [Math.round(rgb[0] * factor), Math.round(rgb[1] * factor), Math.round(rgb[2] * factor)];
}
// smoothstep easing (clamped) for a gentler ramp.
function smoothstep(x: number): number {
    const c = Math.max(0, Math.min(1, x));
    return c * c * (3 - 2 * c);
}

// how far a cell brightens toward white at the shimmer band peak.
const SHIMMER_HIGHLIGHT_MIX = 0.6;
// falloff half-width of the band, in projection units (bigger = smoother spread).
const SHIMMER_BAND = 3;
// the fade-in ramps color from accent darkened by this factor up to full accent.
const FADE_DARK = 0.3;

// smooth 0..1 brightness for a cell: a linear-falloff band moving along `dir`.
function shimmerIntensity(dir: ShimmerDir, row: number, col: number, t: number, tl: Timeline): number {
    if (t < tl.shimmerStart || t >= tl.shimmerEnd) {
        return 0;
    }
    const progress = (t - tl.shimmerStart) / SHIMMER_MS;
    const [lo, hi] = SHIMMER_RANGE[dir];
    const band = lo - SHIMMER_BAND + progress * (hi - lo + SHIMMER_BAND * 2);
    return Math.max(0, 1 - Math.abs(shimmerProjection(dir, row, col) - band) / SHIMMER_BAND);
}

// row-major reveal order of filled glyph cells, for the block-by-block build-in.
const REVEAL_ORDER = new Map<number, number>();
let filledCount = 0;
for (let gr = 0; gr < GLYPH_H; gr++) {
    for (let gc = 0; gc < GLYPH_W; gc++) {
        if (isFilled(gr, gc)) {
            REVEAL_ORDER.set(gr * GLYPH_W + gc, filledCount++);
        }
    }
}

// a random permutation of the same cells, for the scatter build-in (per session).
function shuffledOrder(): Map<number, number> {
    const keys = [...REVEAL_ORDER.keys()];
    for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const order = new Map<number, number>();
    keys.forEach((key, index) => order.set(key, index));
    return order;
}

// empty-to-solid density ramp, used for the quick fade-in.
const FADE_RAMP = [' ', '░', '▒', '▓', '█'] as const;

const LABEL_HEADS   = [ 'pi', 'π'];
const LABEL_SUBS    = ['rho', 'ϱ'];
const LABEL_WEIGHTS = [ 0.67, 0.33];
const LABEL_TAIL = ` v${VERSION}`;

type IntroMode = 'fade' | 'build' | 'scatter';
const INTRO_MODES: IntroMode[] = ['fade', 'build', 'scatter'];
// weights: fade is the common case; the two block fills split the rest.
const INTRO_WEIGHTS = [0.5, 0.25, 0.25];

// animation timeline (ms), ~2s total. the block fills run a touch slower so the
// individual cells are legible; the fade path is quick.
const INTRO_MS: Record<IntroMode, number> = { fade: 400, build: 500, scatter: 500 };
const SHIMMER_DELAY_MS = 150;
const SHIMMER_MS = 500;
const TYPE_DELAY_MS = 150;
const TYPE_PER_CHAR_MS = 60;
const CURSOR_TAIL_MS = 250;
const FRAME_MS = 40;

interface Timeline {
    readonly introEnd: number;
    readonly shimmerStart: number;
    readonly shimmerEnd: number;
    readonly typeStart: number;
    readonly settleAt: number;
}

function timeline(mode: IntroMode, labelLength: number): Timeline {
    const introEnd = INTRO_MS[mode];
    const shimmerStart = introEnd + SHIMMER_DELAY_MS;
    const shimmerEnd = shimmerStart + SHIMMER_MS;
    const typeStart = shimmerEnd + TYPE_DELAY_MS;
    const settleAt = typeStart + labelLength * TYPE_PER_CHAR_MS + CURSOR_TAIL_MS;
    return { introEnd, shimmerStart, shimmerEnd, typeStart, settleAt };
}

// block character for one scaled cell at elapsed time t.
function cellGlyph(row: number, col: number, t: number, mode: IntroMode, order: ReadonlyMap<number, number>, tl: Timeline, finished: boolean): string {
    const gr = Math.floor(row / SCALE_Y);
    const gc = Math.floor(col / SCALE_X);
    if (!isFilled(gr, gc)) {
        return ' ';
    }
    if (finished) {
        return '█';
    }
    if (t < tl.introEnd) {
        if (mode === 'fade') {
            const level = Math.min(FADE_RAMP.length - 1, Math.floor((t / tl.introEnd) * FADE_RAMP.length));
            return FADE_RAMP[level]!;
        }
        const revealed = Math.ceil((t / tl.introEnd) * filledCount);
        return order.get(gr * GLYPH_W + gc)! < revealed ? '█' : ' ';
    }
    // solid during the shimmer; brightness is applied as per-cell rgb in render().
    return '█';
}

// the wordmark is a list of styled segments; the type-on reveal walks the
// concatenation while each segment keeps its own colour/weight. head (pi) is
// bold accent, sub (rho) is the same accent unbolded, the version tail is dim.
interface LabelSegment {
    readonly text: string;
    readonly style: (theme: Theme, s: string) => string;
}

function labelLength(segments: readonly LabelSegment[]): number {
    return segments.reduce((n, seg) => n + seg.text.length, 0);
}

function renderLabel(theme: Theme, segments: readonly LabelSegment[], t: number, tl: Timeline, finished: boolean): string {
    const total = labelLength(segments);
    const shown = finished ? total : Math.max(0, Math.min(total, Math.floor((t - tl.typeStart) / TYPE_PER_CHAR_MS)));
    let out = '';
    let remaining = shown;
    for (const seg of segments) {
        const take = Math.max(0, Math.min(seg.text.length, remaining));
        if (take > 0) {
            out += seg.style(theme, seg.text.slice(0, take));
        }
        remaining -= seg.text.length;
    }
    if (finished) {
        return out;
    }
    // cursor: solid while typing (no blink), then dissolve through the density ramp.
    const typeEnd = tl.typeStart + total * TYPE_PER_CHAR_MS;
    let cursor: string;
    if (t < typeEnd) {
        cursor = '█';
    } else {
        const progress = (t - typeEnd) / CURSOR_TAIL_MS;
        cursor = FADE_RAMP[Math.max(0, FADE_RAMP.length - 1 - Math.floor(progress * FADE_RAMP.length))]!;
    }
    if (cursor !== ' ') {
        out += theme.fg('accent', cursor);
    }
    return out;
}

interface Section {
    readonly label: string;
    readonly items: readonly string[];
    // for the themes section: the name of the currently active theme, so it can
    // render bold while the rest stay dim.
    readonly current?: string;
}

function sortedNames(commands: readonly SlashCommandInfo[], source: SlashCommandInfo['source'], prefix: string): string[] {
    return commands
        .filter((command) => command.source === source)
        .map((command) => `${prefix}${command.name}`)
        .sort((a, b) => a.localeCompare(b));
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode !== 'tui') {
            return;
        }

        try {
            ensureGlobalSetting(['quietStartup'], true);
        } catch {
            // best effort: a settings write failure must never break startup.
        }

        // pick the intro style once per session (weighted fade / build / scatter).
        const mode = choose(INTRO_MODES, INTRO_WEIGHTS);
        // block fills reveal cells in order; scatter uses a random permutation.
        const order = mode === 'scatter' ? shuffledOrder() : REVEAL_ORDER;
        // pick the wordmark once per session (weighted pi/rho vs π/ϱ).
        const [head, sub] = choose(zip(LABEL_HEADS, LABEL_SUBS), LABEL_WEIGHTS);
        const label: LabelSegment[] = [
            { text: head, style: (theme, s) => theme.bold(theme.fg('accent', s)) },
            { text: sub, style: (theme, s) => theme.fg('accent', s) },
            { text: LABEL_TAIL, style: (theme, s) => theme.fg('dim', s) },
        ];
        // pick the shimmer direction once per session (uniform over the four axes).
        const dir = choose(SHIMMER_DIRS);
        const tl = timeline(mode, labelLength(label));

        ctx.ui.setHeader((tui, theme) => {
            const start = Date.now();
            let done = false;
            const timer = setInterval(() => {
                if (Date.now() - start >= tl.settleAt) {
                    done = true;
                    clearInterval(timer);
                }
                tui.requestRender();
            }, FRAME_MS);

            return {
                dispose() {
                    clearInterval(timer);
                },
                invalidate() {},
                render(width: number): string[] {
                    const t = Date.now() - start;
                    const finished = done || t >= tl.settleAt;

                    const accentRgb = themeRgb(theme, 'accent');
                    const highlightRgb = accentRgb ? blend(accentRgb, [255, 255, 255], SHIMMER_HIGHLIGHT_MIX) : undefined;
                    // during the color fade-in every cell shares one accent ramp (darkened -> full).
                    const fadingIn = mode === 'fade' && t < tl.introEnd;
                    const fadeRgb =
                        fadingIn && accentRgb
                            ? blend(darken(accentRgb, FADE_DARK), accentRgb, smoothstep(t / tl.introEnd))
                            : undefined;
                    const logoLines: string[] = [];
                    for (let row = 0; row < LOGO_H; row++) {
                        let line: string;
                        if (accentRgb && highlightRgb) {
                            line = '';
                            for (let col = 0; col < LOGO_W; col++) {
                                const ch = cellGlyph(row, col, t, mode, order, tl, finished);
                                if (ch === ' ') {
                                    line += ' ';
                                    continue;
                                }
                                let cellRgb: Rgb;
                                if (fadeRgb) {
                                    cellRgb = fadeRgb;
                                } else {
                                    const inten = shimmerIntensity(dir, row, col, t, tl);
                                    cellRgb = inten > 0 ? blend(accentRgb, highlightRgb, inten) : accentRgb;
                                }
                                line += ansiFg(cellRgb) + ch;
                            }
                            line += RESET;
                        } else {
                            // 256-color terminals lack truecolor: fall back to flat accent.
                            let cells = '';
                            for (let col = 0; col < LOGO_W; col++) {
                                cells += cellGlyph(row, col, t, mode, order, tl, finished);
                            }
                            line = theme.fg('accent', cells);
                        }
                        if (row === CENTER_ROW && (finished || t >= tl.typeStart)) {
                            line += `   ${renderLabel(theme, label, t, tl, finished)}`;
                        }
                        logoLines.push(line);
                    }

                    const commands = pi.getCommands();
                    const sections: Section[] = [
                        { label: 'prompts', items: sortedNames(commands, 'prompt', '/') },
                        { label: 'skills', items: sortedNames(commands, 'skill', '') },
                        { label: 'commands', items: sortedNames(commands, 'extension', '/') },
                        {
                            label: 'themes',
                            items: ctx.ui
                                .getAllThemes()
                                .filter((entry) => entry.path !== undefined)
                                .map((entry) => entry.name)
                                .sort((a, b) => a.localeCompare(b)),
                            current: theme.name,
                        },
                    ].filter((section) => section.items.length > 0);

                    const labelWidth = sections.reduce((max, section) => Math.max(max, section.label.length), 0);
                    const lines = [...logoLines, '', theme.fg('dim', HINT)];
                    for (const section of sections) {
                        const label = theme.bold(theme.fg('accent', section.label.padEnd(labelWidth)));
                        if (section.current && section.items.includes(section.current)) {
                            // active theme: same `dim` color as the rest, just bold.
                            const parts = section.items.map((name) =>
                                name === section.current
                                    ? theme.bold(theme.fg('dim', name))
                                    : theme.fg('dim', name),
                            );
                            lines.push(`${label}  ${parts.join(theme.fg('dim', ', '))}`);
                        } else {
                            lines.push(`${label}  ${theme.fg('dim', section.items.join(', '))}`);
                        }
                    }

                    return ['', ...lines.map((line) => truncateToWidth(line, width, theme.fg('dim', '...'))), ''];
                },
            };
        });
    });
}
