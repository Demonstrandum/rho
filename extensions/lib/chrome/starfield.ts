// the twinkling stars, as a function of a cell's position and the time.
//
// a port of codex's composer starfield (codex-rs/tui/src/bottom_pane/
// chat_composer/sparkle_field.rs). a cell holds a star when a hash of its
// position lands on one in `density`, so the layout is the same on every
// frame and needs no state. the star is a braille character with one dot
// raised, and the hash also picks which dot, which is what scatters the stars
// below the cell grid.
//
// each star brightens and dims on its own period, 4 to 7 seconds, from its own
// phase. brightness is sin(pi * phase)^12, a spike that keeps a star visible
// for about 40 per cent of its cycle once the dimmest frames are dropped.
// the colour is the cell's own background blended towards `toward` by that
// brightness, so a star can never be brighter than `peak` of the way there.
//
// codex hashes in u64; this hashes in u32, the width the constant 0x45d9f3b
// was chosen for. the pattern differs from codex's cell for cell and has the
// same distribution.

import type { Rgb } from '../core/utils';
import { blend } from '../core/utils';
import { type Row, rgbOf } from '../tui/cells';

export const DOTS = ['\u2801', '\u2802', '\u2804', '\u2808', '\u2810', '\u2820', '\u2840', '\u2880'] as const;

/** below this a star is not drawn at all. */
const THRESHOLD = 0.04;

export interface Sky {
    /** seconds since the stars began */
    time: number;
    /** 0..1, multiplies every star: a fade in or out */
    visibility: number;
    /** 0..1, how far a star at its brightest rises towards `toward` */
    peak: number;
    /** one cell in this many holds a star */
    density: number;
    toward: Rgb;
}

function hash(dx: number, dy: number): number {
    let h = (Math.imul(dy, 65537) + dx) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}

export interface Star {
    glyph: (typeof DOTS)[number];
    brightness: number;
}

/** the star at a position relative to the painted area, or none. */
export function starAt(dx: number, dy: number, sky: Sky): Star | undefined {
    const h = hash(dx, dy);
    if (h % sky.density !== 0) return undefined;
    const period = 4 + (h % 31) / 10;
    const phase = (sky.time / period + (h % 997) / 997) % 1;
    const brightness = Math.sin(phase * Math.PI) ** 12 * sky.peak * sky.visibility;
    if (brightness < THRESHOLD) return undefined;
    return { glyph: DOTS[Math.floor(h / 161) % 8]!, brightness };
}

/**
 * stars into the blank cells of one row: a space, no attribute, a truecolor
 * background. `dy` is the row's place in the painted area. `skip` names
 * columns that must stay as they are. answers whether any cell changed.
 */
export function paintStars(row: Row, dy: number, sky: Sky, skip?: (x: number) => boolean): boolean {
    let changed = false;
    let x = 0;
    for (const cell of row.cells) {
        const at = x;
        x += cell.width;
        if (cell.text !== ' ' || cell.style.attrs.length > 0) continue;
        const bg = rgbOf(cell.style.bg);
        if (bg === undefined || skip?.(at)) continue;
        const star = starAt(at, dy, sky);
        if (star === undefined) continue;
        cell.text = star.glyph;
        cell.style = { ...cell.style, fg: { kind: 'rgb', rgb: blend(bg, sky.toward, star.brightness) } };
        changed = true;
    }
    return changed;
}
