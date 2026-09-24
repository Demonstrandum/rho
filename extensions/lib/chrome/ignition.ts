// the effort ignition, as a function of its style, its tier, and the time.
//
// a port of codex's composer celebration (codex-rs/tui/src/bottom_pane/
// effort_ignition.rs and effort_ignition_styles.rs). codex plays it when the
// reasoning effort changes to Max or Ultra; rho maps pi's two highest thinking
// levels onto those tiers, xhigh to max and max to ultra.
//
// every style is a set of bands. at each frame a band gives every column a
// weight, the hues are mixed by those weights, and the column is tinted with
// the mix: the background of each cell blended towards it, and the foreground
// of a half-block edge character too, since that character is the field's
// background drawn at half height. codex blends from its band colour; this
// blends from the cell's own background, so the field's gradient shows
// through.
//
//   wave    one crest (two at ultra) sweeps across with an ease-in-out,
//           and at ultra a spark steps through · ✦ ✧ at the right end
//   aurora  bands drift on sine paths and add, faded in and out whole
//   pulse   a ring opens from the centre, weakening as it goes
//
// the crest profile is a raised cosine, 1 at the centre and 0 at the half
// width.

import type { Rgb } from '../core/utils';
import { blend } from '../core/utils';
import { type Row, rgbOf } from '../tui/cells';

export type Tier = 'max' | 'ultra';
export type IgnitionStyle = 'wave' | 'aurora' | 'pulse';

const WAVE_HALF_WIDTH = 9;
const PULSE_HALF_WIDTH = 4.5;
const SPARK_START_MS = 900;
const SPARK_FRAME_MS = 100;
const SPARK_GLYPHS = ['\u00b7', '\u2726', '\u2727'] as const;
/** ms between frames while one plays. */
export const FRAME_MS = 33;

/** (launch or speed, travel or phase, strength or hue index) */
type Band = readonly [number, number, number];

const BANDS: Record<IgnitionStyle, Record<Tier, readonly Band[]>> = {
    wave: {
        max: [[0.10, 0.75, 1.0]],
        ultra: [[0.10, 0.70, 1.0], [0.35, 0.55, 1.0]],
    },
    aurora: {
        max: [[0.35, 0.15, 0], [-0.50, 0.60, 1]],
        ultra: [[0.35, 0.15, 0], [-0.50, 0.60, 1], [0.75, 0.35, 2]],
    },
    pulse: {
        max: [[0.10, 0.60, 1.0]],
        ultra: [[0.10, 0.55, 0.8], [0.45, 0.55, 1.1]],
    },
};

const DURATION_MS: Record<IgnitionStyle, Record<Tier, number>> = {
    wave: { max: 1000, ultra: 1300 },
    aurora: { max: 1300, ultra: 1600 },
    pulse: { max: 900, ultra: 1250 },
};

type Hues = readonly [Rgb, Rgb, Rgb];

const HUES: Record<Tier, { dark: Hues; light: Hues }> = {
    max: {
        dark: [[255, 178, 66], [255, 214, 120], [255, 120, 60]],
        light: [[176, 98, 0], [150, 110, 0], [200, 70, 20]],
    },
    ultra: {
        dark: [[186, 130, 255], [255, 120, 220], [120, 170, 255]],
        light: [[124, 58, 217], [190, 40, 150], [30, 100, 220]],
    },
};

export function durationMs(style: IgnitionStyle, tier: Tier): number {
    return DURATION_MS[style][tier];
}

/** a random style from `pool`, never `previous` while the pool has another. */
export function pickStyle(pool: readonly IgnitionStyle[], previous: IgnitionStyle | undefined): IgnitionStyle {
    const choices = pool.length > 1 ? pool.filter((s) => s !== previous) : pool;
    return choices[Math.floor(Math.random() * choices.length)]!;
}

function crest(distance: number): number {
    return distance >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * distance));
}

function easeInOut(p: number): number {
    const t = Math.min(1, Math.max(0, p));
    if (t < 0.5) return 4 * t * t * t;
    const inverse = -2 * t + 2;
    return 1 - (inverse * inverse * inverse) / 2;
}

function envelope(elapsed: number, total: number, fadeIn: number, fadeOut: number): number {
    if (elapsed <= 0 || elapsed >= total) return 0;
    return Math.min(1, Math.max(0, Math.min(elapsed / fadeIn, (total - elapsed) / fadeOut)));
}

/** which hue a band feeds, and how strongly, at one column. */
function sample(style: IgnitionStyle, band: Band, t: number, column: number, width: number): [number, number] {
    const [first, second, third] = band;
    switch (style) {
        case 'wave': {
            const progress = (t - first) / second;
            if (progress < 0 || progress > 1) return [0, 0];
            const centre = easeInOut(progress) * (width + 2 * WAVE_HALF_WIDTH) - WAVE_HALF_WIDTH;
            return [0, crest(Math.abs(column - centre) / WAVE_HALF_WIDTH)];
        }
        case 'aurora': {
            const centre = (0.5 + 0.38 * Math.sin(2 * Math.PI * (first * t + second))) * width;
            const half = Math.max(width * 0.22, 4);
            return [third, crest(Math.abs(column - centre) / half)];
        }
        case 'pulse': {
            const progress = (t - first) / second;
            if (progress < 0 || progress > 1) return [0, 0];
            const inverse = 1 - progress;
            const radius = (1 - inverse * inverse * inverse) * (width / 2 + 2 * PULSE_HALF_WIDTH);
            const distance = Math.abs(column - width / 2);
            return [0, crest(Math.abs(distance - radius) / PULSE_HALF_WIDTH) * third * (1 - 0.6 * progress)];
        }
    }
}

/** the tint for every column at one moment: a hue and an alpha, or none. */
function columns(style: IgnitionStyle, tier: Tier, elapsedMs: number, width: number, hues: Hues): ({ hue: Rgb; alpha: number } | undefined)[] {
    const t = elapsedMs / 1000;
    const total = DURATION_MS[style][tier] / 1000;
    const fade = style === 'aurora' ? envelope(t, total, 0.25, 0.40) : 1;
    const out: ({ hue: Rgb; alpha: number } | undefined)[] = [];
    for (let column = 0; column < width; column++) {
        const weights = [0, 0, 0];
        for (const band of BANDS[style][tier]) {
            const [index, strength] = sample(style, band, t, column, width);
            weights[index] = style === 'aurora' ? weights[index]! + strength : Math.max(weights[index]!, strength);
        }
        const weight = weights[0]! + weights[1]! + weights[2]!;
        if (weight <= 0.01) {
            out.push(undefined);
            continue;
        }
        const mix = [0, 0, 0];
        weights.forEach((w, i) => {
            for (let c = 0; c < 3; c++) mix[c]! += w * hues[i]![c]!;
        });
        const hue: Rgb = [Math.round(mix[0]! / weight), Math.round(mix[1]! / weight), Math.round(mix[2]! / weight)];
        const alpha = style === 'aurora' ? Math.min(weight * 0.40, 0.50) * fade : weight * 0.55;
        out.push({ hue, alpha: Math.min(alpha, 0.6) });
    }
    return out;
}

const HALF_BLOCKS = new Set(['\u2584', '\u2580']);

function luminance(rgb: Rgb): number {
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

function fieldBackground(rows: readonly Row[]): Rgb | undefined {
    for (const row of rows) {
        for (const cell of row.cells) {
            const bg = rgbOf(cell.style.bg);
            if (bg !== undefined) return bg;
        }
    }
    return undefined;
}

export interface Frame {
    style: IgnitionStyle;
    tier: Tier;
    elapsedMs: number;
    /** which row of `rows` the spark may land on */
    sparkRow: number;
}

/**
 * one frame of the ignition over the field's rows, edges included. answers
 * which rows changed; the caller writes those back.
 */
export function paintIgnition(rows: readonly Row[], width: number, frame: Frame): Set<number> {
    const changed = new Set<number>();
    const base = fieldBackground(rows);
    if (base === undefined) return changed;
    const hues = HUES[frame.tier][luminance(base) > 128 ? 'light' : 'dark'];
    const tints = columns(frame.style, frame.tier, frame.elapsedMs, width, hues);

    rows.forEach((row, y) => {
        let x = 0;
        for (const cell of row.cells) {
            const tint = tints[x];
            x += cell.width;
            if (tint === undefined || tint.alpha < 0.02) continue;
            const bg = rgbOf(cell.style.bg);
            const fg = rgbOf(cell.style.fg);
            if (bg !== undefined) {
                cell.style = { ...cell.style, bg: { kind: 'rgb', rgb: blend(bg, tint.hue, tint.alpha) } };
                changed.add(y);
            }
            if (fg !== undefined && HALF_BLOCKS.has(cell.text)) {
                cell.style = { ...cell.style, fg: { kind: 'rgb', rgb: blend(fg, tint.hue, tint.alpha) } };
                changed.add(y);
            }
        }
    });

    if (frame.style === 'wave' && frame.tier === 'ultra' && frame.elapsedMs >= SPARK_START_MS) {
        const glyph = SPARK_GLYPHS[Math.floor((frame.elapsedMs - SPARK_START_MS) / SPARK_FRAME_MS)];
        const row = rows[frame.sparkRow];
        if (glyph !== undefined && row !== undefined && spark(row, width - 2, glyph, hues[0])) {
            changed.add(frame.sparkRow);
        }
    }
    return changed;
}

/** a bold glyph into the blank cell at column `at`, if it is blank. */
function spark(row: Row, at: number, glyph: string, hue: Rgb): boolean {
    let x = 0;
    for (const cell of row.cells) {
        if (x === at) {
            if (cell.text !== ' ' || cell.style.attrs.length > 0) return false;
            cell.text = glyph;
            cell.style = { ...cell.style, attrs: ['1'], fg: { kind: 'rgb', rgb: hue } };
            return true;
        }
        x += cell.width;
        if (x > at) return false;
    }
    return false;
}
