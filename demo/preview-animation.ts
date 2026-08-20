#!/usr/bin/env bun
// isolates the startup logo animation outside a pi session.
//
//   bun run demo/preview-animation.ts              one run, mode picked from config
//   bun run demo/preview-animation.ts rho          force a mode
//   bun run demo/preview-animation.ts --all        every mode in turn
//   bun run demo/preview-animation.ts rho --loop   repeat until ctrl-c
//   bun run demo/preview-animation.ts --accent '#82aaff'
//
// every frame comes from renderLogoLines() in extensions/lib/pi-logo.ts, the
// same function extensions/startup.ts calls, driven by the same rho.toml
// config. the only things this file decides are which accent colour stands in
// for the theme, and that the output goes to stdout instead of the pi header.

import {
    LOGO_H, CENTER_ROW,
    DEFAULT_INTRO_MS, FRAME_MS, TYPE_PER_CHAR_MS, CURSOR_TAIL_MS,
    FADE_RAMP, SHIMMER_DIRS,
    type IntroMode, type LinearShimmerDir, type ShimmerDir, type Timeline,
    timeline, orderFor, shimmerDirFor, renderLogoLines, logoHeight, logoCenterRow,
} from '../extensions/lib/pi-logo';
import {
    createTetrisState, tickTetris,
    PIECE_COLORS_DARK, PIECE_COLORS_LIGHT,
} from '../extensions/lib/tetris-logo';
import { choose, zip, blend, ansiFg, parseHex, RESET, type Rgb } from '../extensions/lib/utils';
import { config } from '../extensions/lib/config';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// stands in for the theme's `accent`. override with --accent '#rrggbb'.
const DEFAULT_ACCENT: Rgb = [130, 170, 255];

// mirrors startup.ts: the wordmark is picked per run from the same weights.
const LABEL_HEADS = ['pi', 'π'];
const LABEL_SUBS = ['rho', 'ϱ'];
const LABEL_WEIGHTS = [0.67, 0.33];
const LABEL_TAIL = ' v0.0';

const INTRO_MS: Record<IntroMode, number> = { ...DEFAULT_INTRO_MS, tetris: 1600 };

const MODE_NAMES: readonly IntroMode[] = ['fade', 'build', 'scatter', 'pi', 'rho', 'tetris'];

function parseMode(name: string): IntroMode | null {
    const resolved = name === 'pirho' ? 'rho' : name;
    return MODE_NAMES.includes(resolved as IntroMode) ? (resolved as IntroMode) : null;
}

// same selection startup.ts makes: modes and weights straight from rho.toml.
function configuredModes(): { modes: IntroMode[]; weights: number[] } {
    const modes: IntroMode[] = [];
    const weights: number[] = [];
    for (let i = 0; i < config.startup.modes.length; i++) {
        const mode = parseMode(config.startup.modes[i]);
        if (mode) {
            modes.push(mode);
            weights.push(config.startup.weights[i] ?? 0);
        }
    }
    if (modes.length === 0) return { modes: ['fade'], weights: [1] };
    return { modes, weights };
}

// the label types on the same way, minus the theme's bold/dim roles.
function renderLabel(text: string, accent: Rgb, t: number, tl: Timeline, finished: boolean): string {
    const shown = finished
        ? text.length
        : Math.max(0, Math.min(text.length, Math.floor((t - tl.typeStart) / TYPE_PER_CHAR_MS)));
    let out = ansiFg(accent) + BOLD + text.slice(0, shown) + RESET;
    if (finished) {
        return out;
    }
    const typeEnd = tl.typeStart + text.length * TYPE_PER_CHAR_MS;
    let cursor: string;
    if (t < typeEnd) {
        cursor = '█';
    } else {
        const p = (t - typeEnd) / CURSOR_TAIL_MS;
        cursor = FADE_RAMP[Math.max(0, FADE_RAMP.length - 1 - Math.floor(p * FADE_RAMP.length))]!;
    }
    if (cursor !== ' ') out += ansiFg(accent) + cursor + RESET;
    return out;
}

interface Run {
    readonly mode: IntroMode;
    readonly accent: Rgb;
    readonly light: boolean;
}

function playOnce({ mode, accent, light }: Run): Promise<void> {
    // every per-run pick below is the one startup.ts makes.
    // built after the timeline below, so the drop fits the scaled intro window.
    let tetrisState: TetrisState | null = null;
    const order = orderFor(mode);
    const [head, sub] = choose(zip(LABEL_HEADS, LABEL_SUBS), LABEL_WEIGHTS);
    const label = head + sub + LABEL_TAIL;

    const configuredDirs = config.startup.shimmerDirs.filter(
        (d): d is LinearShimmerDir => (SHIMMER_DIRS as readonly string[]).includes(d),
    );
    const linearDir = choose(configuredDirs.length > 0 ? configuredDirs : SHIMMER_DIRS);
    const dir: ShimmerDir = shimmerDirFor(mode, linearDir);
    const tl = timeline(INTRO_MS[mode], mode, label.length, config.startup.durationMs);
    const tetrisColors = light ? PIECE_COLORS_LIGHT : PIECE_COLORS_DARK;
    if (mode === 'tetris') {
        tetrisState = createTetrisState(tl.introEnd);
    }

    // tetris draws a taller block, so the scroll-back distance follows the mode.
    const height = logoHeight(mode);
    const labelRow = logoCenterRow(mode);

    const header = `${DIM}  ${mode}  ${dir}  ${Math.round(tl.settleAt)}ms${RESET}`;
    process.stdout.write('\n'.repeat(height + 1));

    const start = Date.now();
    return new Promise((resolve) => {
        const tick = () => {
            const t = Date.now() - start;
            const finished = t >= tl.settleAt;
            if (tetrisState && t < tl.introEnd) {
                tickTetris(tetrisState, t);
            }

            const lines = renderLogoLines({
                t, mode, dir, order, tl, finished, accent, tetrisColors, tetrisState,
            });
            if (finished || t >= tl.typeStart) {
                lines[labelRow] += `   ${renderLabel(label, accent, t, tl, finished)}`;
            }

            process.stdout.write(`\x1b[${height + 1}A${header}\n`);
            for (const line of lines) {
                process.stdout.write(line + '\x1b[K\n');
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

function parseAccent(argv: string[]): Rgb {
    const i = argv.indexOf('--accent');
    if (i === -1) return DEFAULT_ACCENT;
    return parseHex(argv[i + 1] ?? '') ?? DEFAULT_ACCENT;
}

async function main() {
    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter((a) => a.startsWith('--')));
    const accent = parseAccent(argv);
    const light = flags.has('--light');

    const named = argv.filter((a) => !a.startsWith('--')).map((a) => parseMode(a.toLowerCase()));
    const explicit = named.filter((m): m is IntroMode => m !== null);

    let queue: IntroMode[];
    if (flags.has('--all')) {
        queue = [...MODE_NAMES];
    } else if (explicit.length > 0) {
        queue = explicit;
    } else {
        const { modes, weights } = configuredModes();
        queue = [choose(modes, weights)];
    }

    process.stdout.write(HIDE_CURSOR);
    try {
        do {
            for (const mode of queue) {
                await playOnce({ mode, accent, light });
                if (queue.length > 1) await new Promise((r) => setTimeout(r, 600));
            }
        } while (flags.has('--loop'));
    } finally {
        process.stdout.write(SHOW_CURSOR + '\n');
    }
}

main();
