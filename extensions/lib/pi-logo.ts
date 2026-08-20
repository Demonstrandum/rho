// the pi wordmark intro animation, as pure functions of elapsed time.
//
// this is the single source for the glyph, the reveal schedules, and the
// shimmer. extensions/startup.ts renders it against the live theme; the
// preview under demo/ renders it against a fixed colour. neither owns a copy,
// so the preview cannot drift from what a session actually shows.
//
// in a subdirectory so pi's extension auto-discovery (top-level *.ts only)
// does not try to load it as an extension.

import type { Rgb } from './utils';

// pi wordmark, transcribed from the hand-drawn glyph ('1' = filled), scaled up
// with block characters. the drawn shape is deliberately asymmetric.
export const GLYPH: readonly number[][] = [
    [1, 1, 1, 0],
    [1, 0, 1, 0],
    [1, 1, 0, 1],
    [1, 0, 0, 1],
];
export const SCALE_X = 2;
export const SCALE_Y = 1;

export const GLYPH_H = GLYPH.length;
export const GLYPH_W = Math.max(...GLYPH.map((row) => row.length));
export const LOGO_W = GLYPH_W * SCALE_X;
export const LOGO_H = GLYPH_H * SCALE_Y;
export const CENTER_ROW = Math.floor((LOGO_H - 1) / 2);

export const isFilled = (gr: number, gc: number): boolean => GLYPH[gr]?.[gc] === 1;

// the glyph holds two readable shapes:
//
// P (8 cells)          I (2 cells)        RHO (9 cells)
//   ###                    #                ###
//   # #                    #                # #
//   ##                                      ## #
//   #                                          #
//
// the reveal draws P then I. the shimmer traces P then I, or traces the RHO.
// RHO reuses the same block art minus the P stem, plus the I column as its
// tail.

// reveal order: P cells in reading order, then the I cells.
export const PI_PATH: readonly [number, number][] = [
    [0,0], [0,1], [0,2],
    [1,0], [1,2],
    [2,0], [2,1],
    [3,0],
    [2,3], [3,3],
];

export const P_COUNT = 8;

// shimmer traces, in stroke order: every step is next to the one before it,
// so the highlight walks the shape the way a pen would draw it. reading order
// would jump between distant cells and light unrelated parts at once.

// P: up the stem, across the top, down and around the bowl.
//   (3,0) (2,0) (1,0) (0,0) (0,1) (0,2) (1,2) (2,1)
export const P_SHIMMER: readonly [number, number][] = [
    [3,0], [2,0], [1,0],
    [0,0], [0,1], [0,2],
    [1,2],
    [2,1],
];

// RHO: around the bowl, then out and down the tail. no P stem at (3,0).
//   (2,1) (2,0) (1,0) (0,0) (0,1) (0,2) (1,2) (2,3) (3,3)
export const RHO_SHIMMER: readonly [number, number][] = [
    [2,1], [2,0], [1,0],
    [0,0], [0,1], [0,2],
    [1,2],
    [2,3], [3,3],
];

// the I, written after the P in the pi trace.
const I_CELLS: readonly [number, number][] = [
    [2,3], [3,3],
];

export const PI_SHIMMER: readonly [number, number][] = [...P_SHIMMER, ...I_CELLS];

function pathOrder(path: readonly [number, number][]): Map<number, number> {
    const m = new Map<number, number>();
    path.forEach(([gr, gc], i) => m.set(gr * GLYPH_W + gc, i));
    return m;
}

export const PI_ORDER = pathOrder(PI_PATH);
const P_SHIMMER_ORDER = pathOrder(P_SHIMMER);
const RHO_SHIMMER_ORDER = pathOrder(RHO_SHIMMER);

// index units of pen lift between the P and the I. the head crosses these
// with no cell under it, so the trace visibly pauses before starting the I.
// a plain sequential order would run the two letters together.
const PI_LIFT = 3;

const PI_SHIMMER_ORDER: ReadonlyMap<number, number> = (() => {
    const m = new Map<number, number>();
    P_SHIMMER.forEach(([gr, gc], i) => m.set(gr * GLYPH_W + gc, i));
    const iStart = P_SHIMMER.length - 1 + PI_LIFT;
    I_CELLS.forEach(([gr, gc], i) => m.set(gr * GLYPH_W + gc, iStart + i));
    return m;
})();

// highest index in the pi trace, counting the lift.
const PI_TRACE_LEN = P_SHIMMER.length - 1 + PI_LIFT + I_CELLS.length - 1;

// per-cell reveal times as 0..1 intro progress. P fills the first 60%, a gap
// holds the drawn P alone, then the I fills the last 25%.
const P_REVEAL_END = 0.60;
const I_REVEAL_START = 0.75;
// how long one cell takes to ramp from dark to full, in intro progress.
const CELL_FADE_SPAN = 0.15;

export const PIRHO_REVEAL: readonly number[] = (() => {
    const times: number[] = [];
    for (let i = 0; i < P_COUNT; i++) {
        times.push((i / P_COUNT) * P_REVEAL_END);
    }
    const iCount = PI_PATH.length - P_COUNT;
    for (let i = 0; i < iCount; i++) {
        times.push(I_REVEAL_START + (i / iCount) * (1 - I_REVEAL_START));
    }
    return times;
})();

// row-major reveal order of filled cells, for the block-by-block build-in.
export const REVEAL_ORDER = new Map<number, number>();
export let filledCount = 0;
for (let gr = 0; gr < GLYPH_H; gr++) {
    for (let gc = 0; gc < GLYPH_W; gc++) {
        if (isFilled(gr, gc)) {
            REVEAL_ORDER.set(gr * GLYPH_W + gc, filledCount++);
        }
    }
}

// a random permutation of the same cells, for the scatter build-in.
export function shuffledOrder(): Map<number, number> {
    const keys = [...REVEAL_ORDER.keys()];
    for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const order = new Map<number, number>();
    keys.forEach((key, index) => order.set(key, index));
    return order;
}

export type IntroMode = 'fade' | 'build' | 'scatter' | 'pi' | 'rho' | 'tetris';

// the reveal order a mode walks. scatter is random per call.
export function orderFor(mode: IntroMode): Map<number, number> {
    if (mode === 'scatter') return shuffledOrder();
    if (mode === 'pi' || mode === 'rho') return PI_ORDER;
    return REVEAL_ORDER;
}

export type ShimmerDir = 'ns' | 'ew' | 'nwse' | 'nesw' | 'pi' | 'rho';
export type LinearShimmerDir = 'ns' | 'ew' | 'nwse' | 'nesw';
export const SHIMMER_DIRS: LinearShimmerDir[] = ['ns', 'ew', 'nwse', 'nesw'];

// the shimmer direction a mode uses; linear modes take the caller's pick.
export function shimmerDirFor(mode: IntroMode, fallback: ShimmerDir): ShimmerDir {
    if (mode === 'pi' || mode === 'rho') return mode;
    return fallback;
}

const SHIMMER_RANGE: Record<LinearShimmerDir, readonly [number, number]> = {
    ns: [0, LOGO_H - 1],
    ew: [0, LOGO_W - 1],
    nwse: [0, LOGO_W - 1 + (LOGO_H - 1)],
    nesw: [-(LOGO_W - 1), LOGO_H - 1],
};

function shimmerProjection(dir: LinearShimmerDir, row: number, col: number): number {
    switch (dir) {
        case 'ns': return row;
        case 'ew': return col;
        case 'nwse': return row + col;
        case 'nesw': return row - col;
    }
}

export function darken(rgb: Rgb, factor: number): Rgb {
    return [Math.round(rgb[0] * factor), Math.round(rgb[1] * factor), Math.round(rgb[2] * factor)];
}

export function smoothstep(x: number): number {
    const c = Math.max(0, Math.min(1, x));
    return c * c * (3 - 2 * c);
}

// how far a cell brightens toward white at the shimmer band peak.
export const SHIMMER_HIGHLIGHT_MIX = 0.6;
// falloff half-width of the linear band, in projection units.
const SHIMMER_BAND = 3;
// how far the trace glow trails behind the head, in cells. the head is the
// only cell at full brightness; nothing ahead of it lights at all.
const TRACE_TAIL = 3.4;
// the fade-in ramps colour from accent darkened by this factor up to accent.
export const FADE_DARK = 0.3;
// share of the shimmer window spent resting between the P and RHO traces.
const PIRHO_GAP_FRAC = 0.06;

// empty-to-solid density ramp, used for the quick fade-in and the cursor.
export const FADE_RAMP = [' ', '░', '▒', '▓', '█'] as const;

// one trace along a stroke order: a single head walks the path and drags a
// short glow behind it. a cell ahead of the head is dark, so at any instant
// the lit run is one connected piece of the stroke, never two apart.
function pathShimmerIntensity(
    row: number, col: number, t: number,
    ord: ReadonlyMap<number, number>, pathLen: number,
    passStart: number, passEnd: number,
): number {
    const gr = Math.floor(row / SCALE_Y);
    const gc = Math.floor(col / SCALE_X);
    const proj = ord.get(gr * GLYPH_W + gc);
    if (proj === undefined) {
        return 0;
    }
    const progress = (t - passStart) / (passEnd - passStart);
    // run the head past the end so the last cell's tail drains inside the pass.
    const head = progress * (pathLen + TRACE_TAIL);
    const behind = head - proj;
    if (behind < 0) {
        return 0;
    }
    return Math.max(0, 1 - behind / TRACE_TAIL);
}

// trace the P, rest, then trace the RHO. the P trace never touches the I
// cells and the RHO trace never touches the P stem, so each sweep draws out
// one shape from the block art.
function rhoShimmerIntensity(row: number, col: number, t: number, tl: Timeline): number {
    const dur = tl.shimmerEnd - tl.shimmerStart;
    const gapMs = dur * PIRHO_GAP_FRAC;
    const passMs = (dur - gapMs) / 2;
    const pEnd = tl.shimmerStart + passMs;
    const rhoStart = pEnd + gapMs;
    if (t < pEnd) {
        return pathShimmerIntensity(row, col, t, P_SHIMMER_ORDER, P_SHIMMER.length - 1, tl.shimmerStart, pEnd);
    }
    if (t >= rhoStart) {
        return pathShimmerIntensity(row, col, t, RHO_SHIMMER_ORDER, RHO_SHIMMER.length - 1, rhoStart, tl.shimmerEnd);
    }
    return 0;
}

// 0..1 brightness of one cell under the moving highlight.
export function shimmerIntensity(dir: ShimmerDir, row: number, col: number, t: number, tl: Timeline): number {
    if (t < tl.shimmerStart || t >= tl.shimmerEnd) {
        return 0;
    }
    if (dir === 'rho') {
        return rhoShimmerIntensity(row, col, t, tl);
    }
    if (dir === 'pi') {
        return pathShimmerIntensity(row, col, t, PI_SHIMMER_ORDER, PI_TRACE_LEN, tl.shimmerStart, tl.shimmerEnd);
    }
    const progress = (t - tl.shimmerStart) / (tl.shimmerEnd - tl.shimmerStart);
    const [lo, hi] = SHIMMER_RANGE[dir];
    const band = lo - SHIMMER_BAND + progress * (hi - lo + SHIMMER_BAND * 2);
    return Math.max(0, 1 - Math.abs(shimmerProjection(dir, row, col) - band) / SHIMMER_BAND);
}

// intro durations per mode. tetris is driven by config, so callers pass it in.
export const DEFAULT_INTRO_MS: Record<Exclude<IntroMode, 'tetris'>, number> = {
    fade: 400,
    build: 500,
    scatter: 500,
    pi: 600,
    rho: 600,
};

export const SHIMMER_DELAY_MS = 150;
const SHIMMER_MS_DEFAULT = 500;
// pi runs one trace; rho runs two traces with a gap, so it needs more.
const SHIMMER_MS_PI = 750;
const SHIMMER_MS_RHO = 1050;
export const TYPE_DELAY_MS = 150;
export const TYPE_PER_CHAR_MS = 60;
export const CURSOR_TAIL_MS = 250;
export const FRAME_MS = 40;

export function shimmerMs(mode: IntroMode): number {
    if (mode === 'rho') return SHIMMER_MS_RHO;
    if (mode === 'pi') return SHIMMER_MS_PI;
    return SHIMMER_MS_DEFAULT;
}

export interface Timeline {
    readonly introEnd: number;
    readonly shimmerStart: number;
    readonly shimmerEnd: number;
    readonly typeStart: number;
    readonly settleAt: number;
}

// total run time at the unscaled defaults, used to derive the scale factor
// when a caller asks for a specific total.
function defaultTotalMs(mode: IntroMode, labelLength: number): number {
    const introMs = mode === 'tetris' ? 1600 : DEFAULT_INTRO_MS[mode];
    return introMs + SHIMMER_DELAY_MS + shimmerMs(mode) + TYPE_DELAY_MS
        + labelLength * TYPE_PER_CHAR_MS + CURSOR_TAIL_MS;
}

// `targetMs`, when given, scales every phase so the whole sequence fits it.
export function timeline(introMs: number, mode: IntroMode, labelLength: number, targetMs?: number): Timeline {
    const s = targetMs ? targetMs / defaultTotalMs(mode, labelLength) : 1;
    const introEnd = introMs * s;
    const shimmerStart = introEnd + SHIMMER_DELAY_MS * s;
    const shimmerEnd = shimmerStart + shimmerMs(mode) * s;
    const typeStart = shimmerEnd + TYPE_DELAY_MS * s;
    const settleAt = typeStart + labelLength * TYPE_PER_CHAR_MS * s + CURSOR_TAIL_MS * s;
    return { introEnd, shimmerStart, shimmerEnd, typeStart, settleAt };
}

// block character for one scaled cell at elapsed time t.
export function cellGlyph(
    row: number, col: number, t: number, mode: IntroMode,
    order: ReadonlyMap<number, number>, tl: Timeline, finished: boolean,
): string {
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
        if (mode === 'pi' || mode === 'rho') {
            const idx = order.get(gr * GLYPH_W + gc)!;
            return t / tl.introEnd >= PIRHO_REVEAL[idx] ? '█' : ' ';
        }
        const revealed = Math.ceil((t / tl.introEnd) * filledCount);
        return order.get(gr * GLYPH_W + gc)! < revealed ? '█' : ' ';
    }
    return '█';
}

// 0..1 brightness of one cell during a path reveal, so each cell ramps from
// dark to full as it appears rather than popping in.
export function pathCellFade(
    row: number, col: number, t: number,
    order: ReadonlyMap<number, number>, tl: Timeline,
): number {
    const gr = Math.floor(row / SCALE_Y);
    const gc = Math.floor(col / SCALE_X);
    const idx = order.get(gr * GLYPH_W + gc) ?? 0;
    const age = (t / tl.introEnd - PIRHO_REVEAL[idx]) / CELL_FADE_SPAN;
    return smoothstep(Math.max(0, Math.min(1, age)));
}
