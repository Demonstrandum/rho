// small helpers shared across extensions, moved here verbatim from the files
// that first defined them (startup.ts, spinner.ts) so they live in one place.
// in a subdirectory so pi's extension auto-discovery (top-level *.ts only) does
// not try to load it as an extension.

import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';

export const zip = <T extends unknown[][]>(...arrays: T) =>
  arrays[0].map((_, i) => arrays.map((a) => a[i])) as {
    [K in keyof T]: T[K] extends (infer U)[] ? U : never
  }[];

export function choose<T>(items: T[], weights?: number[]): T {
    const n = items.length;
    const w = weights || Array(n).fill(1/n);
    const cum = w.reduce((c, x) => [...c, c[c.length-1] + x], [0]).slice(1);
    const t = Math.random() * cum[n - 1];

    for (const [c, it] of zip(cum, items) as [number, T][]) {
        if (c > t) return it;
    }

    return items[n - 1];
}

export type Rgb = [number, number, number];

// pull the truecolor rgb behind a theme role; undefined in 256-color mode.
export function themeRgb(theme: Theme, color: ThemeColor): Rgb | undefined {
    const match = theme.getFgAnsi(color).match(/38;2;(\d+);(\d+);(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function blend(a: Rgb, b: Rgb, t: number): Rgb {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ];
}

export function ansiFg(rgb: Rgb): string {
    return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

export function ansiBg(rgb: Rgb): string {
    return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

// pull the truecolor rgb behind a theme bg role; undefined in 256-color mode.
// the bg role string is typed as `never` at the call site because ThemeBg is
// not re-exported from the package entry, but getBgAnsi accepts it at runtime.
export function themeBgRgb(theme: Theme, color: string): Rgb | undefined {
    const match = (theme as { getBgAnsi(c: string): string }).getBgAnsi(color)
        .match(/48;2;(\d+);(\d+);(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

// extract rgb from an arbitrary ansi fg escape (38;2;r;g;b).
export function parseFgRgb(ansi: string): Rgb | undefined {
    const m = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function parseHex(hex: string): Rgb | undefined {
    const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) return undefined;
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export type Hsl = [number, number, number]; // h: 0-360, s: 0-100, l: 0-100

export function rgbToHsl(rgb: Rgb): Hsl {
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return [h * 360, s * 100, l * 100];
}

export function hslToRgb(hsl: Hsl): Rgb {
    const h = hsl[0] / 360, s = hsl[1] / 100, l = hsl[2] / 100;
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
        Math.round(hue2rgb(p, q, h + 1/3) * 255),
        Math.round(hue2rgb(p, q, h) * 255),
        Math.round(hue2rgb(p, q, h - 1/3) * 255),
    ];
}

// apply filter modifiers to an HSL colour.
// each filter: channel (h/s/l) + operator (=/+/-/*) + number.
// e.g. "l=80", "s-30", "h+10", "s*0.5"
const FILTER_RE = /^([hsl])([=+\-*])(\-?[0-9]*\.?[0-9]+)$/;

export function applyHslFilters(hsl: Hsl, filters: string[]): Hsl {
    const out: Hsl = [...hsl];
    for (const f of filters) {
        const m = f.match(FILTER_RE);
        if (!m) continue;
        const ch = m[1] === 'h' ? 0 : m[1] === 's' ? 1 : 2;
        const v = Number(m[3]);
        switch (m[2]) {
            case '=': out[ch] = v; break;
            case '+': out[ch] += v; break;
            case '-': out[ch] -= v; break;
            case '*': out[ch] *= v; break;
        }
    }
    // clamp: hue wraps, s and l clamp to [0, 100]
    out[0] = ((out[0] % 360) + 360) % 360;
    out[1] = Math.max(0, Math.min(100, out[1]));
    out[2] = Math.max(0, Math.min(100, out[2]));
    return out;
}

export const RESET = '\x1b[0m';

// template helpers: standard namespace available inside {{...}} expressions.

/** random integer in [min, max] inclusive */
export function randint(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

/** random float in [min, max), rounded to `decimals` places (default 2) */
export function randfloat(min: number, max: number, decimals = 2): number {
    const v = min + Math.random() * (max - min);
    return Number(v.toFixed(decimals));
}

/** pick one element from an array at random */
export function pick<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}
