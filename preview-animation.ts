#!/usr/bin/env bun
// standalone preview of the startup logo animation. run: bun preview-animation.ts
// pass a mode name to preview one: bun preview-animation.ts pirho

const GLYPH: readonly number[][] = [
    [1, 1, 1, 0],
    [1, 0, 1, 0],
    [1, 1, 0, 1],
    [1, 0, 0, 1],
];
const SCALE_X = 2;
const SCALE_Y = 1;
const GLYPH_H = GLYPH.length;
const GLYPH_W = Math.max(...GLYPH.map((r) => r.length));
const LOGO_W = GLYPH_W * SCALE_X;
const LOGO_H = GLYPH_H * SCALE_Y;
const isFilled = (gr: number, gc: number) => GLYPH[gr]?.[gc] === 1;

type Rgb = [number, number, number];
const ansiFg = (rgb: Rgb) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const blend = (a: Rgb, b: Rgb, t: number): Rgb => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
];
const darken = (rgb: Rgb, f: number): Rgb => [
    Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f),
];
const smoothstep = (x: number) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };

// paths
const PI_PATH: [number, number][] = [
    [0,0],[0,1],[0,2], [1,0],[1,2], [2,0],[2,1], [3,0], [2,3],[3,3],
];
const RHO_PATH: [number, number][] = [
    [0,0],[0,1],[0,2], [1,2], [2,1],[2,0], [1,0], [2,3],[3,3], [3,0],
];
const P_COUNT = 8;

function pathOrder(path: [number, number][]): Map<number, number> {
    const m = new Map<number, number>();
    path.forEach(([gr, gc], i) => m.set(gr * GLYPH_W + gc, i));
    return m;
}
const PI_ORDER = pathOrder(PI_PATH);
const RHO_ORDER = pathOrder(RHO_PATH);

// per-cell reveal times: P fills first 60%, gap 15%, I fills last 25%
const PIRHO_REVEAL: number[] = (() => {
    const times: number[] = [];
    for (let i = 0; i < P_COUNT; i++) times.push(i / P_COUNT * 0.60);
    const iCount = PI_PATH.length - P_COUNT;
    for (let i = 0; i < iCount; i++) times.push(0.75 + i / iCount * 0.25);
    return times;
})();

// row-major reveal
const REVEAL_ORDER = new Map<number, number>();
let filledCount = 0;
for (let gr = 0; gr < GLYPH_H; gr++)
    for (let gc = 0; gc < GLYPH_W; gc++)
        if (isFilled(gr, gc)) REVEAL_ORDER.set(gr * GLYPH_W + gc, filledCount++);

function shuffledOrder(): Map<number, number> {
    const keys = [...REVEAL_ORDER.keys()];
    for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const m = new Map<number, number>();
    keys.forEach((k, i) => m.set(k, i));
    return m;
}

// shimmer
type ShimmerDir = 'ns' | 'ew' | 'nwse' | 'nesw' | 'pi' | 'pirho';
const SHIMMER_DIRS: ShimmerDir[] = ['ns', 'ew', 'nwse', 'nesw'];
const SHIMMER_RANGE: Record<string, readonly [number, number]> = {
    ns: [0, LOGO_H - 1], ew: [0, LOGO_W - 1],
    nwse: [0, LOGO_W - 1 + (LOGO_H - 1)], nesw: [-(LOGO_W - 1), LOGO_H - 1],
};

function shimmerProjection(dir: string, row: number, col: number): number {
    switch (dir) {
        case 'ns': return row;
        case 'ew': return col;
        case 'nwse': return row + col;
        case 'nesw': return row - col;
        default: return 0;
    }
}

const SHIMMER_BAND = 3;
const PATH_SHIMMER_BAND = 2;
const PIRHO_GAP_FRAC = 0.12;

type IntroMode = 'fade' | 'build' | 'scatter' | 'pi' | 'pirho';

const INTRO_MS: Record<IntroMode, number> = { fade: 400, build: 500, scatter: 500, pi: 900, pirho: 900 };
const SHIMMER_DELAY = 150;
const SHIMMER_MS_DEFAULT = 500;
const SHIMMER_MS_PI = 800;
const SHIMMER_MS_PIRHO = 1800;
const TYPE_DELAY = 150;
const TYPE_PER_CHAR = 60;
const CURSOR_TAIL = 250;
const FRAME_MS = 40;
const FADE_DARK = 0.3;
const SHIMMER_MIX = 0.6;
const FADE_RAMP = [' ', '░', '▒', '▓', '█'] as const;

const ACCENT: Rgb = [130, 170, 255];
const HIGHLIGHT: Rgb = blend(ACCENT, [255, 255, 255], SHIMMER_MIX);

interface Timeline {
    introEnd: number; shimmerStart: number; shimmerEnd: number;
    typeStart: number; settleAt: number;
}

function shimmerMs(mode: IntroMode): number {
    if (mode === 'pirho') return SHIMMER_MS_PIRHO;
    if (mode === 'pi') return SHIMMER_MS_PI;
    return SHIMMER_MS_DEFAULT;
}

function timeline(mode: IntroMode, labelLen: number): Timeline {
    const introEnd = INTRO_MS[mode];
    const shimmerStart = introEnd + SHIMMER_DELAY;
    const shimmerEnd = shimmerStart + shimmerMs(mode);
    const typeStart = shimmerEnd + TYPE_DELAY;
    const settleAt = typeStart + labelLen * TYPE_PER_CHAR + CURSOR_TAIL;
    return { introEnd, shimmerStart, shimmerEnd, typeStart, settleAt };
}

function pathShimmerIntensity(
    row: number, col: number, t: number,
    ord: ReadonlyMap<number, number>, passStart: number, passEnd: number,
): number {
    if (t < passStart || t >= passEnd) return 0;
    const gr = Math.floor(row / SCALE_Y);
    const gc = Math.floor(col / SCALE_X);
    const proj = ord.get(gr * GLYPH_W + gc) ?? -99;
    const bw = PATH_SHIMMER_BAND;
    const pathLen = PI_PATH.length - 1;
    const progress = (t - passStart) / (passEnd - passStart);
    const band = -bw + progress * (pathLen + bw * 2);
    return Math.max(0, 1 - Math.abs(proj - band) / bw);
}

function pirhoShimmerIntensity(row: number, col: number, t: number, tl: Timeline): number {
    if (t < tl.shimmerStart || t >= tl.shimmerEnd) return 0;
    const dur = tl.shimmerEnd - tl.shimmerStart;
    const gapMs = dur * PIRHO_GAP_FRAC;
    const passMs = (dur - gapMs) / 2;
    const piEnd = tl.shimmerStart + passMs;
    const rhoStart = piEnd + gapMs;
    if (t < piEnd) {
        return pathShimmerIntensity(row, col, t, PI_ORDER, tl.shimmerStart, piEnd);
    }
    if (t >= rhoStart) {
        return pathShimmerIntensity(row, col, t, RHO_ORDER, rhoStart, tl.shimmerEnd);
    }
    return 0;
}

function shimmerIntensity(dir: ShimmerDir, row: number, col: number, t: number, tl: Timeline): number {
    if (t < tl.shimmerStart || t >= tl.shimmerEnd) return 0;
    if (dir === 'pirho') return pirhoShimmerIntensity(row, col, t, tl);
    if (dir === 'pi') return pathShimmerIntensity(row, col, t, PI_ORDER, tl.shimmerStart, tl.shimmerEnd);
    const progress = (t - tl.shimmerStart) / (tl.shimmerEnd - tl.shimmerStart);
    const [lo, hi] = SHIMMER_RANGE[dir];
    const band = lo - SHIMMER_BAND + progress * (hi - lo + SHIMMER_BAND * 2);
    return Math.max(0, 1 - Math.abs(shimmerProjection(dir, row, col) - band) / SHIMMER_BAND);
}

function cellGlyph(
    row: number, col: number, t: number, mode: IntroMode,
    order: ReadonlyMap<number, number>, tl: Timeline, finished: boolean,
): string {
    const gr = Math.floor(row / SCALE_Y);
    const gc = Math.floor(col / SCALE_X);
    if (!isFilled(gr, gc)) return ' ';
    if (finished) return '█';
    if (t < tl.introEnd) {
        if (mode === 'fade') {
            const level = Math.min(FADE_RAMP.length - 1, Math.floor((t / tl.introEnd) * FADE_RAMP.length));
            return FADE_RAMP[level]!;
        }
        if (mode === 'pi' || mode === 'pirho') {
            const idx = order.get(gr * GLYPH_W + gc)!;
            const progress = t / tl.introEnd;
            return progress >= PIRHO_REVEAL[idx] ? '█' : ' ';
        }
        const revealed = Math.ceil((t / tl.introEnd) * filledCount);
        return order.get(gr * GLYPH_W + gc)! < revealed ? '█' : ' ';
    }
    return '█';
}

function renderLabel(t: number, tl: Timeline, finished: boolean): string {
    const head = 'pi';
    const sub = 'rho';
    const tail = ' v0.0';
    const full = head + sub + tail;
    const shown = finished ? full.length : Math.max(0, Math.min(full.length, Math.floor((t - tl.typeStart) / TYPE_PER_CHAR)));
    let out = '';
    const parts: [string, string][] = [
        [head, BOLD + ansiFg(ACCENT)],
        [sub, ansiFg(ACCENT)],
        [tail, DIM],
    ];
    let rem = shown;
    for (const [text, style] of parts) {
        const take = Math.max(0, Math.min(text.length, rem));
        if (take > 0) out += style + text.slice(0, take) + RESET;
        rem -= text.length;
    }
    if (!finished) {
        const typeEnd = tl.typeStart + full.length * TYPE_PER_CHAR;
        let cursor: string;
        if (t < typeEnd) {
            cursor = '█';
        } else {
            const p = (t - typeEnd) / CURSOR_TAIL;
            cursor = FADE_RAMP[Math.max(0, FADE_RAMP.length - 1 - Math.floor(p * FADE_RAMP.length))]!;
        }
        if (cursor !== ' ') out += ansiFg(ACCENT) + cursor + RESET;
    }
    return out;
}

function renderFrame(
    t: number, mode: IntroMode, dir: ShimmerDir,
    order: ReadonlyMap<number, number>, tl: Timeline,
): string[] {
    const finished = t >= tl.settleAt;
    const fadingIn = mode === 'fade' && t < tl.introEnd;
    const fadeRgb = fadingIn
        ? blend(darken(ACCENT, FADE_DARK), ACCENT, smoothstep(t / tl.introEnd))
        : undefined;
    const pathFade = (mode === 'pi' || mode === 'pirho') && t < tl.introEnd;
    const centerRow = Math.floor((LOGO_H - 1) / 2);
    const lines: string[] = [];

    for (let row = 0; row < LOGO_H; row++) {
        let line = '';
        for (let col = 0; col < LOGO_W; col++) {
            const ch = cellGlyph(row, col, t, mode, order, tl, finished);
            if (ch === ' ') { line += ' '; continue; }
            let rgb: Rgb;
            if (fadeRgb) {
                rgb = fadeRgb;
            } else if (pathFade) {
                const gr = Math.floor(row / SCALE_Y);
                const gc = Math.floor(col / SCALE_X);
                const idx = order.get(gr * GLYPH_W + gc) ?? 0;
                const revealAt = PIRHO_REVEAL[idx];
                const progress = t / tl.introEnd;
                const cellAge = (progress - revealAt) / 0.15;
                rgb = blend(darken(ACCENT, FADE_DARK), ACCENT, smoothstep(Math.max(0, Math.min(1, cellAge))));
            } else {
                const inten = shimmerIntensity(dir, row, col, t, tl);
                rgb = inten > 0 ? blend(ACCENT, HIGHLIGHT, inten) : ACCENT;
            }
            line += ansiFg(rgb) + ch + RESET;
        }
        if (row === centerRow && (finished || t >= tl.typeStart)) {
            line += '   ' + renderLabel(t, tl, finished);
        }
        lines.push(line);
    }
    return lines;
}

// --- runner ---

async function runOne(mode: IntroMode) {
    const dir: ShimmerDir = mode === 'pirho' ? 'pirho'
        : mode === 'pi' ? 'pi'
        : SHIMMER_DIRS[Math.floor(Math.random() * SHIMMER_DIRS.length)];
    const order = mode === 'scatter' ? shuffledOrder()
        : (mode === 'pi' || mode === 'pirho') ? PI_ORDER
        : REVEAL_ORDER;
    const labelLen = 'pirho v0.0'.length;
    const tl = timeline(mode, labelLen);

    // reserve lines
    process.stdout.write('\n'.repeat(LOGO_H + 1));

    const start = Date.now();
    return new Promise<void>((resolve) => {
        const tick = () => {
            const t = Date.now() - start;
            const lines = renderFrame(t, mode, dir, order, tl);
            process.stdout.write(`\x1b[${LOGO_H + 1}A`);
            const tag = `${DIM}  [${mode}]${RESET}`;
            process.stdout.write(tag + '\n');
            for (const l of lines) {
                process.stdout.write(l + '\x1b[K\n');
            }
            if (t >= tl.settleAt + 200) {
                resolve();
            } else {
                setTimeout(tick, FRAME_MS);
            }
        };
        tick();
    });
}

const ALL_MODES: IntroMode[] = ['fade', 'build', 'scatter', 'pi', 'pirho'];

async function main() {
    const arg = process.argv[2]?.toLowerCase();
    const modes = arg && ALL_MODES.includes(arg as IntroMode)
        ? [arg as IntroMode]
        : ALL_MODES;

    process.stdout.write('\x1b[?25l'); // hide cursor
    for (const mode of modes) {
        await runOne(mode);
        if (modes.length > 1) await new Promise((r) => setTimeout(r, 800));
    }
    process.stdout.write('\x1b[?25h'); // show cursor
    process.stdout.write('\n');
}

main();
