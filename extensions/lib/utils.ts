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

export const RESET = '\x1b[0m';
