import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    GLYPH, GLYPH_H, GLYPH_W, SCALE_X, SCALE_Y, LOGO_H, isFilled,
    PI_PATH, P_COUNT, P_SHIMMER, RHO_SHIMMER, PI_SHIMMER, PI_ORDER,
    PIRHO_REVEAL, REVEAL_ORDER, shuffledOrder, orderFor, shimmerDirFor,
    SHIMMER_DIRS, DEFAULT_INTRO_MS, TYPE_OVERLAP, TYPE_PER_CHAR_MS, CURSOR_TAIL_MS,
    shimmerMs, shimmerIntensity, timeline, cellGlyph, pathCellFade,
    renderLogoLines, logoHeight, logoCenterRow,
    type IntroMode, type ShimmerDir, type Timeline,
} from '../extensions/lib/pi-logo';

type Cell = readonly [number, number];

const key = ([gr, gc]: Cell) => gr * GLYPH_W + gc;
// shimmerIntensity works in scaled render space, not glyph space.
const at = ([gr, gc]: Cell) => [gr * SCALE_Y, gc * SCALE_X] as const;

const FILLED: Cell[] = (() => {
    const cells: Cell[] = [];
    for (let gr = 0; gr < GLYPH_H; gr++) {
        for (let gc = 0; gc < GLYPH_W; gc++) {
            if (isFilled(gr, gc)) cells.push([gr, gc]);
        }
    }
    return cells;
})();

const P_STEM: Cell = [3, 0];
const I_CELLS: Cell[] = [[2, 3], [3, 3]];

const LABEL_LEN = 10;
const introFor = (mode: IntroMode) => (mode === 'tetris' ? 1600 : DEFAULT_INTRO_MS[mode]);
const tlFor = (mode: IntroMode, targetMs?: number) =>
    timeline(introFor(mode), mode, LABEL_LEN, targetMs);

// the whole glyph is 10 cells; the shapes partition into 8 + 2.

test('the glyph has ten filled cells and the P/I split covers them exactly', () => {
    expect(FILLED.length).toBe(10);
    expect(P_COUNT).toBe(8);
    expect(PI_PATH.length).toBe(10);
    expect(new Set(PI_PATH.map(key)).size).toBe(10);
    expect(new Set(PI_PATH.map(key))).toEqual(new Set(FILLED.map(key)));
});

test('each shimmer shape holds only filled cells, with no repeats', () => {
    for (const [name, shape] of [['P', P_SHIMMER], ['RHO', RHO_SHIMMER], ['PI', PI_SHIMMER]] as const) {
        expect(`${name}:${shape.length}`).toBe(`${name}:${new Set(shape.map(key)).size}`);
        for (const [gr, gc] of shape) {
            expect(`${name} (${gr},${gc}) filled`).toBe(`${name} (${gr},${gc}) ${isFilled(gr, gc)}`.replace('true', 'filled'));
        }
    }
});

test('the P shape is the eight P cells and excludes the I column', () => {
    expect(P_SHIMMER.length).toBe(8);
    const cells = new Set(P_SHIMMER.map(key));
    expect(cells.has(key(P_STEM))).toBe(true);
    for (const cell of I_CELLS) {
        expect(cells.has(key(cell))).toBe(false);
    }
});

test('the RHO shape is nine cells: the bowl and tail, without the P stem', () => {
    expect(RHO_SHIMMER.length).toBe(9);
    const cells = new Set(RHO_SHIMMER.map(key));
    expect(cells.has(key(P_STEM))).toBe(false);
    for (const cell of I_CELLS) {
        expect(cells.has(key(cell))).toBe(true);
    }
});

test('the PI trace is the P followed by the I', () => {
    expect(PI_SHIMMER.length).toBe(10);
    expect(PI_SHIMMER.slice(0, P_SHIMMER.length).map(key)).toEqual(P_SHIMMER.map(key));
    expect(PI_SHIMMER.slice(P_SHIMMER.length).map(key)).toEqual(I_CELLS.map(key));
});

// a trace is only legible if consecutive steps touch. reading order jumps
// between distant cells, which lights unrelated parts of the glyph at once.

test('every step of a shimmer trace is adjacent to the one before it', () => {
    for (const [name, shape] of [['P', P_SHIMMER], ['RHO', RHO_SHIMMER]] as const) {
        for (let i = 1; i < shape.length; i++) {
            const [r0, c0] = shape[i - 1];
            const [r1, c1] = shape[i];
            const step = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0));
            expect(`${name} ${i}: (${r0},${c0})->(${r1},${c1}) step ${step}`)
                .toBe(`${name} ${i}: (${r0},${c0})->(${r1},${c1}) step 1`);
        }
    }
});

// sampling helpers for the shimmer.

const SAMPLES = 400;
function sampleShimmer(dir: ShimmerDir, tl: Timeline): { t: number; lit: Cell[] }[] {
    const frames: { t: number; lit: Cell[] }[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
        const t = tl.shimmerStart + ((tl.shimmerEnd - tl.shimmerStart) * i) / SAMPLES;
        const lit = FILLED.filter((cell) => shimmerIntensity(dir, ...at(cell), t, tl) > 0.01);
        frames.push({ t, lit });
    }
    return frames;
}

// the head walks one path, so the lit cells are always one unbroken run of
// that path. two lit pieces with a dark gap between them would mean the
// highlight is in two places at once.
function contiguousIn(path: readonly Cell[], lit: Cell[]): boolean {
    const index = new Map(path.map((cell, i) => [key(cell), i]));
    const idx = lit.map((cell) => index.get(key(cell)));
    if (idx.some((i) => i === undefined)) return false;
    const sorted = (idx as number[]).sort((a, b) => a - b);
    return sorted[sorted.length - 1] - sorted[0] === sorted.length - 1;
}

test('the pi trace lights one unbroken run at a time, never two apart', () => {
    const tl = tlFor('pi');
    for (const { t, lit } of sampleShimmer('pi', tl)) {
        if (lit.length === 0) continue;
        expect(`t=${Math.round(t)} contiguous=${contiguousIn(PI_SHIMMER, lit)}`)
            .toBe(`t=${Math.round(t)} contiguous=true`);
    }
});

test('the rho mode lights one unbroken run of whichever shape it is tracing', () => {
    const tl = tlFor('rho');
    for (const { t, lit } of sampleShimmer('rho', tl)) {
        if (lit.length === 0) continue;
        const ok = contiguousIn(P_SHIMMER, lit) || contiguousIn(RHO_SHIMMER, lit);
        expect(`t=${Math.round(t)} traced-shape=${ok}`).toBe(`t=${Math.round(t)} traced-shape=true`);
    }
});

test('the rho mode traces the P first and the rho second, with a rest between', () => {
    const tl = tlFor('rho');
    const frames = sampleShimmer('rho', tl);

    // the P stem belongs to the P only, the tail to the rho only, so each one
    // dates the pass that lit it.
    const stemLit = frames.filter((f) => f.lit.some((c) => key(c) === key(P_STEM)));
    const tailLit = frames.filter((f) => f.lit.some((c) => key(c) === key(I_CELLS[1])));
    expect(stemLit.length).toBeGreaterThan(0);
    expect(tailLit.length).toBeGreaterThan(0);
    expect(stemLit[stemLit.length - 1].t).toBeLessThan(tailLit[0].t);

    // the two passes do not run together: some frame between them is dark.
    const between = frames.filter(
        (f) => f.t > stemLit[stemLit.length - 1].t && f.t < tailLit[0].t && f.lit.length === 0,
    );
    expect(between.length).toBeGreaterThan(0);
});

test('the second rho pass never lights the P stem', () => {
    const tl = tlFor('rho');
    const frames = sampleShimmer('rho', tl);
    const tailStart = frames.find((f) => f.lit.some((c) => key(c) === key(I_CELLS[0])))!.t;
    for (const { t, lit } of frames) {
        if (t < tailStart) continue;
        expect(`t=${Math.round(t)} stem-lit=${lit.some((c) => key(c) === key(P_STEM))}`)
            .toBe(`t=${Math.round(t)} stem-lit=false`);
    }
});

test('the pi trace reaches the I only after the whole P', () => {
    const tl = tlFor('pi');
    const frames = sampleShimmer('pi', tl);
    const lastP = frames.filter((f) => f.lit.some((c) => key(c) === key(P_SHIMMER[P_SHIMMER.length - 1])));
    const firstI = frames.find((f) => f.lit.some((c) => key(c) === key(I_CELLS[0])))!;
    expect(firstI.t).toBeGreaterThan(lastP[0].t);
});

// a trace is a moving head, not a wash over the whole shape. these two tests
// pin that: the lit run stays short, and it is brightest at the leading end.

const MAX_LIT = 5;

test('the trace stays a short run, never flooding the shape', () => {
    for (const [dir, shape] of [['pi', PI_SHIMMER], ['rho', RHO_SHIMMER]] as const) {
        const tl = tlFor(dir);
        for (const { t, lit } of sampleShimmer(dir, tl)) {
            expect(`${dir} t=${Math.round(t)} lit=${lit.length} of ${shape.length}`)
                .toBe(`${dir} t=${Math.round(t)} lit=${Math.min(lit.length, MAX_LIT)} of ${shape.length}`);
        }
    }
});

test('the trace is brightest at the head and fades behind it', () => {
    const tl = tlFor('pi');
    const index = new Map(PI_SHIMMER.map((cell, i) => [key(cell), i]));
    let checked = 0;

    for (const { t, lit } of sampleShimmer('pi', tl)) {
        if (lit.length < 2) continue;
        const graded = lit
            .map((cell) => ({
                i: index.get(key(cell))!,
                v: shimmerIntensity('pi', ...at(cell), t, tl),
            }))
            .sort((a, b) => a.i - b.i);

        // the last cell reached is the brightest one on screen.
        const head = graded[graded.length - 1];
        for (const cell of graded.slice(0, -1)) {
            expect(`t=${Math.round(t)} head ${head.v.toFixed(3)} > ${cell.v.toFixed(3)}`)
                .toBe(`t=${Math.round(t)} head ${head.v.toFixed(3)} > ${Math.min(cell.v, head.v - 1e-9).toFixed(3)}`);
        }
        // and brightness only decreases as you walk back down the trace.
        for (let i = 1; i < graded.length; i++) {
            expect(graded[i].v).toBeGreaterThan(graded[i - 1].v);
        }
        checked++;
    }
    expect(checked).toBeGreaterThan(50);
});

test('no cell lights outside the shimmer window', () => {
    for (const dir of ['pi', 'rho', ...SHIMMER_DIRS] as ShimmerDir[]) {
        const tl = tlFor(dir === 'pi' || dir === 'rho' ? dir : 'fade');
        for (const cell of FILLED) {
            expect(shimmerIntensity(dir, ...at(cell), tl.shimmerStart - 1, tl)).toBe(0);
            expect(shimmerIntensity(dir, ...at(cell), tl.shimmerEnd, tl)).toBe(0);
        }
    }
});

// the timeline: phase order, the overlap, and the configured total.

test('the phases run in order and the shimmer sits after the intro', () => {
    for (const mode of ['fade', 'build', 'scatter', 'pi', 'rho'] as IntroMode[]) {
        const tl = tlFor(mode);
        expect(`${mode}: intro<=shimmer ${tl.introEnd <= tl.shimmerStart}`).toBe(`${mode}: intro<=shimmer true`);
        expect(`${mode}: shimmer has width ${tl.shimmerEnd > tl.shimmerStart}`).toBe(`${mode}: shimmer has width true`);
        expect(`${mode}: settles last ${tl.settleAt >= tl.shimmerEnd}`).toBe(`${mode}: settles last true`);
    }
});

test('the label starts typing half way through the shimmer', () => {
    for (const mode of ['fade', 'build', 'scatter', 'pi', 'rho'] as IntroMode[]) {
        const tl = tlFor(mode);
        const into = (tl.typeStart - tl.shimmerStart) / (tl.shimmerEnd - tl.shimmerStart);
        expect(`${mode}: ${into.toFixed(3)}`).toBe(`${mode}: ${TYPE_OVERLAP.toFixed(3)}`);
        expect(tl.typeStart).toBeLessThan(tl.shimmerEnd);
    }
});

test('the run ends when both the shimmer and the label have finished', () => {
    for (const mode of ['fade', 'build', 'scatter', 'pi', 'rho'] as IntroMode[]) {
        const tl = tlFor(mode);
        const typeEnd = tl.typeStart + LABEL_LEN * TYPE_PER_CHAR_MS * (tl.settleAt / tlFor(mode).settleAt);
        expect(tl.settleAt).toBeGreaterThanOrEqual(tl.shimmerEnd);
        expect(tl.settleAt).toBeGreaterThan(typeEnd - CURSOR_TAIL_MS);
    }
});

test('a requested total is the total, for every non-tetris mode', () => {
    for (const target of [1500, 2500, 4000]) {
        for (const mode of ['fade', 'build', 'scatter', 'pi', 'rho'] as IntroMode[]) {
            const tl = tlFor(mode, target);
            expect(`${mode}@${target}: ${Math.round(tl.settleAt)}`).toBe(`${mode}@${target}: ${target}`);
        }
    }
});

test('rho spends longer shimmering than pi, because it traces twice', () => {
    expect(shimmerMs('rho')).toBeGreaterThan(shimmerMs('pi'));
});

// the reveal that runs before the shimmer.

test('the reveal draws every P cell before any I cell, with a pause between', () => {
    expect(PIRHO_REVEAL.length).toBe(PI_PATH.length);
    const pTimes = PIRHO_REVEAL.slice(0, P_COUNT);
    const iTimes = PIRHO_REVEAL.slice(P_COUNT);
    expect(Math.max(...pTimes)).toBeLessThan(Math.min(...iTimes));
    // the gap is real, not a rounding artefact.
    expect(Math.min(...iTimes) - Math.max(...pTimes)).toBeGreaterThan(0.1);
});

test('reveal times only ever move forward', () => {
    for (let i = 1; i < PIRHO_REVEAL.length; i++) {
        expect(PIRHO_REVEAL[i]).toBeGreaterThan(PIRHO_REVEAL[i - 1]);
    }
});

test('during the pause the P stands complete and the I is absent', () => {
    const mode: IntroMode = 'pi';
    const tl = tlFor(mode);
    const order = orderFor(mode);
    const pauseAt = tl.introEnd * ((Math.max(...PIRHO_REVEAL.slice(0, P_COUNT)) + Math.min(...PIRHO_REVEAL.slice(P_COUNT))) / 2);

    for (const cell of P_SHIMMER) {
        expect(cellGlyph(...at(cell), pauseAt, mode, order, tl, false)).toBe('█');
    }
    for (const cell of I_CELLS) {
        expect(cellGlyph(...at(cell), pauseAt, mode, order, tl, false)).toBe(' ');
    }
});

test('a finished frame is the solid glyph, whatever the mode', () => {
    for (const mode of ['fade', 'build', 'scatter', 'pi', 'rho'] as IntroMode[]) {
        const tl = tlFor(mode);
        const order = orderFor(mode);
        for (const cell of FILLED) {
            expect(cellGlyph(...at(cell), tl.settleAt, mode, order, tl, true)).toBe('█');
        }
        // an unfilled cell stays blank at every stage.
        expect(cellGlyph(0, 3 * SCALE_X, tl.settleAt, mode, order, tl, true)).toBe(' ');
    }
});

test('a cell fades in over the reveal rather than appearing at full brightness', () => {
    const mode: IntroMode = 'pi';
    const tl = tlFor(mode);
    const order = orderFor(mode);
    const first = P_SHIMMER[0];
    const born = PIRHO_REVEAL[PI_ORDER.get(key(first))!] * tl.introEnd;

    expect(pathCellFade(...at(first), born, order, tl)).toBeCloseTo(0, 5);
    expect(pathCellFade(...at(first), tl.introEnd, order, tl)).toBeCloseTo(1, 5);
    // and it is monotone in between.
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
        const v = pathCellFade(...at(first), born + ((tl.introEnd - born) * i) / 20, order, tl);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
    }
});

// mode plumbing.

test('each mode reveals in the order that suits it', () => {
    expect(orderFor('pi')).toBe(PI_ORDER);
    expect(orderFor('rho')).toBe(PI_ORDER);
    expect(orderFor('build')).toBe(REVEAL_ORDER);
    expect(orderFor('fade')).toBe(REVEAL_ORDER);
});

test('scatter reorders the same cells rather than dropping any', () => {
    const scattered = orderFor('scatter');
    expect(new Set(scattered.keys())).toEqual(new Set(REVEAL_ORDER.keys()));
    expect(new Set(scattered.values())).toEqual(new Set(REVEAL_ORDER.values()));
});

test('shuffledOrder gives a permutation, not a truncation', () => {
    for (let i = 0; i < 20; i++) {
        const order = shuffledOrder();
        expect(order.size).toBe(REVEAL_ORDER.size);
        expect(new Set(order.values())).toEqual(new Set(REVEAL_ORDER.values()));
    }
});

test('trace modes shimmer along their own path and ignore the axis offered', () => {
    expect(shimmerDirFor('pi', 'ns')).toBe('pi');
    expect(shimmerDirFor('rho', 'nwse')).toBe('rho');
    for (const dir of SHIMMER_DIRS) {
        expect(shimmerDirFor('fade', dir)).toBe(dir);
        expect(shimmerDirFor('tetris', dir)).toBe(dir);
    }
});

// the shared renderer.

test('a frame has one line per logo row and the label row is inside it', () => {
    for (const mode of ['fade', 'build', 'scatter', 'pi', 'rho', 'tetris'] as IntroMode[]) {
        const tl = tlFor(mode);
        const lines = renderLogoLines({
            t: tl.shimmerStart, mode, dir: shimmerDirFor(mode, 'ns'),
            order: orderFor(mode), tl, finished: false,
            accent: [130, 170, 255], tetrisColors: {}, tetrisState: null,
        });
        expect(`${mode}: ${lines.length}`).toBe(`${mode}: ${logoHeight(mode)}`);
        expect(logoCenterRow(mode)).toBeLessThan(lines.length);
    }
});

test('a settled frame carries colour and block characters', () => {
    const mode: IntroMode = 'rho';
    const tl = tlFor(mode);
    const lines = renderLogoLines({
        t: tl.settleAt, mode, dir: 'rho', order: orderFor(mode), tl, finished: true,
        accent: [130, 170, 255], tetrisColors: {}, tetrisState: null,
    });
    const body = lines.join('\n');
    expect(body).toContain('█');
    expect(body).toContain('\x1b[38;2;130;170;255m');
});

test('the renderer is a pure function of its inputs', () => {
    const mode: IntroMode = 'pi';
    const tl = tlFor(mode);
    const frame = {
        t: tl.shimmerStart + 100, mode, dir: 'pi' as ShimmerDir, order: orderFor(mode), tl,
        finished: false, accent: [130, 170, 255] as [number, number, number],
        tetrisColors: {}, tetrisState: null,
    };
    expect(renderLogoLines(frame)).toEqual(renderLogoLines(frame));
});

// the guard that started all this: one implementation, two callers.

test('startup and the demo both drive the shared module, holding no copy', () => {
    const root = join(import.meta.dir, '..');
    const sources = {
        'extensions/startup.ts': readFileSync(join(root, 'extensions/startup.ts'), 'utf8'),
        'demo/preview-animation.ts': readFileSync(join(root, 'demo/preview-animation.ts'), 'utf8'),
    };
    for (const [name, src] of Object.entries(sources)) {
        expect(`${name} imports pi-logo: ${src.includes('lib/pi-logo')}`).toBe(`${name} imports pi-logo: true`);
        expect(`${name} calls renderLogoLines: ${src.includes('renderLogoLines(')}`).toBe(`${name} calls renderLogoLines: true`);
        // the shapes and the trace constants live in the module alone.
        for (const symbol of ['P_SHIMMER:', 'RHO_SHIMMER:', 'TRACE_TAIL', 'PI_LIFT']) {
            expect(`${name} redefines ${symbol}: ${src.includes(`const ${symbol}`)}`)
                .toBe(`${name} redefines ${symbol}: false`);
        }
    }
});
