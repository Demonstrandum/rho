// the animated wordmark: the logo rows and the label that types out beside them.
//
// one card is one playing of the intro. it picks its mode, its wordmark and its
// shimmer direction at construction, from `[startup]` in rho.toml, and renders
// as a pure function of elapsed milliseconds, so a resize or a repaint mid-run
// draws the same frame. playing it again means building another card, which is
// what the theme picker does on every preview.
//
// startup.ts draws one of these under its resource listing at session start;
// theme.ts draws one in the picker so a theme is judged on the thing the reader
// sees first. neither owns the animation, and the two cannot drift apart.

import type { Theme } from '@earendil-works/pi-coding-agent';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { choose, themeRgb, zip } from './utils';
import { config } from './config';
import { createTetrisState, tickTetris, PIECE_COLORS_DARK, PIECE_COLORS_LIGHT } from './tetris-logo';
import {
    CENTER_ROW, CURSOR_TAIL_MS, DEFAULT_INTRO_MS, FADE_RAMP, LOGO_H, SHIMMER_DIRS, TYPE_PER_CHAR_MS,
    logoCenterRow, orderFor, plainLogoRow, renderLogoLines, shimmerDirFor, timeline,
    type IntroMode, type LinearShimmerDir, type ShimmerDir, type Timeline,
} from './pi-logo';

const LABEL_HEADS = ['pi', 'π'];
const LABEL_SUBS = ['rho', 'ϱ'];
const LABEL_WEIGHTS = [0.67, 0.33];
const LABEL_TAIL = ` v${VERSION}`;

/** intro duration per mode; every mode but tetris takes the shared default. */
const INTRO_MS: Record<IntroMode, number> = {
    ...DEFAULT_INTRO_MS,
    tetris: 1600,
};

const MODE_NAMES: readonly IntroMode[] = ['fade', 'build', 'scatter', 'pi', 'rho', 'tetris'];

// 'pirho' was the old name for the two-trace mode, now 'rho'.
function parseMode(name: string): IntroMode | null {
    const resolved = name === 'pirho' ? 'rho' : name;
    return MODE_NAMES.includes(resolved as IntroMode) ? (resolved as IntroMode) : null;
}

function configuredModes(): { modes: IntroMode[]; weights: number[] } {
    const modes: IntroMode[] = [];
    const weights: number[] = [];
    for (let i = 0; i < config.startup.modes.length; i++) {
        const mode = parseMode(config.startup.modes[i]!);
        if (mode) {
            modes.push(mode);
            weights.push(config.startup.weights[i] ?? 0);
        }
    }
    if (modes.length === 0) return { modes: ['fade'], weights: [1] };
    return { modes, weights };
}

/**
 * the wordmark as styled segments. the type-on reveal walks the concatenation
 * while each segment keeps its own colour and weight: the head (pi) is bold
 * accent, the sub (rho) the same accent unbolded, the version tail dim.
 */
interface LabelSegment {
    readonly text: string;
    readonly style: (theme: Theme, text: string) => string;
}

function labelLength(segments: readonly LabelSegment[]): number {
    return segments.reduce((n, segment) => n + segment.text.length, 0);
}

function renderLabel(
    theme: Theme,
    segments: readonly LabelSegment[],
    t: number,
    tl: Timeline,
    finished: boolean,
): string {
    const total = labelLength(segments);
    const shown = finished ? total : Math.max(0, Math.min(total, Math.floor((t - tl.typeStart) / TYPE_PER_CHAR_MS)));
    let out = '';
    let remaining = shown;
    for (const segment of segments) {
        const take = Math.max(0, Math.min(segment.text.length, remaining));
        if (take > 0) out += segment.style(theme, segment.text.slice(0, take));
        remaining -= segment.text.length;
    }
    if (finished) return out;

    // the cursor is solid while typing, with no blink, then dissolves through
    // the density ramp.
    const typeEnd = tl.typeStart + total * TYPE_PER_CHAR_MS;
    const cursor = t < typeEnd
        ? '█'
        : FADE_RAMP[Math.max(0, FADE_RAMP.length - 1 - Math.floor(((t - typeEnd) / CURSOR_TAIL_MS) * FADE_RAMP.length))]!;
    return cursor === ' ' ? out : out + theme.fg('accent', cursor);
}

export interface IntroCard {
    readonly mode: IntroMode;
    /** elapsed milliseconds after which the card no longer changes. */
    readonly settleAt: number;
    /** the logo rows at this instant, label included. */
    render(theme: Theme, elapsed: number): string[];
}

export function createIntro(): IntroCard {
    const { modes, weights } = configuredModes();
    const mode = choose(modes, weights);
    // block fills reveal cells in order; scatter uses a random permutation.
    const order = orderFor(mode);
    const [head, sub] = choose(zip(LABEL_HEADS, LABEL_SUBS), LABEL_WEIGHTS);
    const label: LabelSegment[] = [
        { text: head!, style: (theme, s) => theme.bold(theme.fg('accent', s)) },
        { text: sub!, style: (theme, s) => theme.fg('accent', s) },
        { text: LABEL_TAIL, style: (theme, s) => theme.fg('dim', s) },
    ];
    // trace modes shimmer along their own path; the rest sweep an axis from config.
    const configured = config.startup.shimmerDirs.filter(
        (d): d is LinearShimmerDir => (SHIMMER_DIRS as readonly string[]).includes(d),
    );
    const dir: ShimmerDir = shimmerDirFor(mode, choose(configured.length > 0 ? configured : SHIMMER_DIRS));
    const tl = timeline(INTRO_MS[mode], mode, labelLength(label), config.startup.durationMs);
    // the drop sequence owns the whole intro window, so the clear finishes
    // exactly as the shimmer takes over the settled glyph.
    const tetrisState = mode === 'tetris' ? createTetrisState(tl.introEnd) : null;

    return {
        mode,
        settleAt: tl.settleAt,
        render(theme: Theme, elapsed: number): string[] {
            const t = config.startup.animate ? elapsed : tl.settleAt;
            const finished = t >= tl.settleAt;
            if (tetrisState && t < tl.introEnd) tickTetris(tetrisState, t);

            const accent = themeRgb(theme, 'accent');
            // tetris piece colours follow the theme's light or dark cast.
            const isLight = theme.name?.toLowerCase().includes('light') ?? false;
            const tetrisColors = isLight ? PIECE_COLORS_LIGHT : PIECE_COLORS_DARK;

            // truecolor: the shared renderer draws every cell. a 256-colour
            // terminal has no rgb to blend, so it gets flat accent.
            const lines = accent
                ? renderLogoLines({ t, mode, dir, order, tl, finished, accent, tetrisColors, tetrisState })
                : Array.from({ length: LOGO_H }, (_, row) =>
                    theme.fg('accent', plainLogoRow(row, t, mode, order, tl, finished)));

            if (finished || t >= tl.typeStart) {
                const row = accent ? logoCenterRow(mode) : CENTER_ROW;
                lines[row] += `   ${renderLabel(theme, label, t, tl, finished)}`;
            }
            return lines;
        },
    };
}
