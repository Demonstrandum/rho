#!/usr/bin/env bun
// preview of the startup logo animation.
//
//   bun run demo/preview-animation.ts              every mode, random shimmer
//   bun run demo/preview-animation.ts build        one mode, random shimmer
//   bun run demo/preview-animation.ts build ns     one mode, one shimmer axis
//   bun run demo/preview-animation.ts build all    one mode, every shimmer axis
//   bun run demo/preview-animation.ts all ns       every mode, one shimmer axis
//   bun run demo/preview-animation.ts --list       valid names
//
// mode and shimmer are independent axes, so either can be pinned while the
// other varies. the exception is pi and rho, whose shimmer follows the drawn
// trace rather than a straight line, so a requested axis does not apply; the
// label reports `path` when that happens rather than a value that was ignored.
//
// the animation lives in extensions/lib/pi-logo.ts and is imported, not
// copied, so this preview always shows what a real session shows.

import {
    LOGO_W, LOGO_H, CENTER_ROW,
    DEFAULT_INTRO_MS, FRAME_MS, TYPE_PER_CHAR_MS, CURSOR_TAIL_MS,
    FADE_RAMP, FADE_DARK, SHIMMER_HIGHLIGHT_MIX, SHIMMER_DIRS,
    type IntroMode, type LinearShimmerDir, type ShimmerDir, type Timeline,
    timeline, cellGlyph, shimmerIntensity, orderFor, shimmerDirFor,
    pathCellFade, darken, smoothstep,
} from '../extensions/lib/pi-logo';
import { blend, ansiFg, RESET, type Rgb } from '../extensions/lib/utils';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const ACCENT: Rgb = [130, 170, 255];
const HIGHLIGHT: Rgb = blend(ACCENT, [255, 255, 255], SHIMMER_HIGHLIGHT_MIX);

const LABEL_HEAD = 'pi';
const LABEL_SUB = 'rho';
const LABEL_TAIL = ' v0.0';

function renderLabel(t: number, tl: Timeline, finished: boolean): string {
    const full = LABEL_HEAD + LABEL_SUB + LABEL_TAIL;
    const shown = finished
        ? full.length
        : Math.max(0, Math.min(full.length, Math.floor((t - tl.typeStart) / TYPE_PER_CHAR_MS)));
    const parts: [string, string][] = [
        [LABEL_HEAD, BOLD + ansiFg(ACCENT)],
        [LABEL_SUB, ansiFg(ACCENT)],
        [LABEL_TAIL, DIM],
    ];
    let out = '';
    let rem = shown;
    for (const [text, style] of parts) {
        const take = Math.max(0, Math.min(text.length, rem));
        if (take > 0) out += style + text.slice(0, take) + RESET;
        rem -= text.length;
    }
    if (finished) {
        return out;
    }
    const typeEnd = tl.typeStart + full.length * TYPE_PER_CHAR_MS;
    let cursor: string;
    if (t < typeEnd) {
        cursor = '█';
    } else {
        const p = (t - typeEnd) / CURSOR_TAIL_MS;
        cursor = FADE_RAMP[Math.max(0, FADE_RAMP.length - 1 - Math.floor(p * FADE_RAMP.length))]!;
    }
    if (cursor !== ' ') out += ansiFg(ACCENT) + cursor + RESET;
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
    const pathFade = (mode === 'pi' || mode === 'rho') && t < tl.introEnd;
    const lines: string[] = [];

    for (let row = 0; row < LOGO_H; row++) {
        let line = '';
        for (let col = 0; col < LOGO_W; col++) {
            const ch = cellGlyph(row, col, t, mode, order, tl, finished);
            if (ch === ' ') {
                line += ' ';
                continue;
            }
            let rgb: Rgb;
            if (fadeRgb) {
                rgb = fadeRgb;
            } else if (pathFade) {
                rgb = blend(darken(ACCENT, FADE_DARK), ACCENT, pathCellFade(row, col, t, order, tl));
            } else {
                const inten = shimmerIntensity(dir, row, col, t, tl);
                rgb = inten > 0 ? blend(ACCENT, HIGHLIGHT, inten) : ACCENT;
            }
            line += ansiFg(rgb) + ch + RESET;
        }
        if (row === CENTER_ROW && (finished || t >= tl.typeStart)) {
            line += '   ' + renderLabel(t, tl, finished);
        }
        lines.push(line);
    }
    return lines;
}

const LABEL_LEN = (LABEL_HEAD + LABEL_SUB + LABEL_TAIL).length;

function pickDir(requested: LinearShimmerDir | undefined): LinearShimmerDir {
    return requested ?? SHIMMER_DIRS[Math.floor(Math.random() * SHIMMER_DIRS.length)]!;
}

function runOne(mode: IntroMode, requested: LinearShimmerDir | undefined): Promise<void> {
    const dir = shimmerDirFor(mode, pickDir(requested));
    // shimmerDirFor returns the mode itself for pi and rho, meaning the shimmer
    // follows the trace instead of an axis.
    const shownDir: string = dir === mode ? 'path' : dir;
    const order = orderFor(mode);
    const introMs = mode === 'tetris' ? 1600 : DEFAULT_INTRO_MS[mode];
    const tl = timeline(introMs, mode, LABEL_LEN);

    process.stdout.write('\n'.repeat(LOGO_H + 1));

    const start = Date.now();
    return new Promise((resolve) => {
        const tick = () => {
            const t = Date.now() - start;
            const lines = renderFrame(t, mode, dir, order, tl);
            process.stdout.write(`\x1b[${LOGO_H + 1}A`);
            process.stdout.write(`${DIM}  [${mode} \u00b7 ${shownDir}]${RESET}\n`);
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

const ALL_MODES: IntroMode[] = ['fade', 'build', 'scatter', 'pi', 'rho', 'tetris'];

// 'pirho' was the old name for the two-trace mode, now 'rho'.
function parseMode(arg: string): IntroMode | undefined {
    const name = arg === 'pirho' ? 'rho' : arg;
    return ALL_MODES.includes(name as IntroMode) ? (name as IntroMode) : undefined;
}

function parseDir(arg: string): LinearShimmerDir | undefined {
    return SHIMMER_DIRS.includes(arg as LinearShimmerDir) ? (arg as LinearShimmerDir) : undefined;
}

function usage(): string {
    return [
        'usage: bun run demo/preview-animation.ts [mode] [shimmer]',
        '',
        `  mode     ${ALL_MODES.join(', ')}, or all (default)`,
        `  shimmer  ${SHIMMER_DIRS.join(', ')}, all, or omitted for a random axis`,
        '',
        '  pi and rho shimmer along the drawn trace, so a requested axis',
        '  does not apply to them and the label reads `path`.',
    ].join('\n');
}

function fail(message: string): never {
    process.stderr.write(`${message}\n\n${usage()}\n`);
    process.exit(1);
}

async function main() {
    const modeArg = process.argv[2]?.toLowerCase();
    const dirArg = process.argv[3]?.toLowerCase();

    if (modeArg === '--list' || modeArg === '--help' || modeArg === '-h') {
        process.stdout.write(`${usage()}\n`);
        return;
    }

    let modes: IntroMode[];
    if (modeArg === undefined || modeArg === 'all') {
        modes = ALL_MODES;
    } else {
        const mode = parseMode(modeArg);
        if (!mode) fail(`unknown mode: ${modeArg}`);
        modes = [mode];
    }

    // undefined means "choose a fresh random axis per run", which is what the
    // real startup does; naming one pins it so runs can be compared.
    let dirs: (LinearShimmerDir | undefined)[];
    if (dirArg === undefined) {
        dirs = [undefined];
    } else if (dirArg === 'all') {
        dirs = [...SHIMMER_DIRS];
    } else {
        const dir = parseDir(dirArg);
        if (!dir) fail(`unknown shimmer axis: ${dirArg}`);
        dirs = [dir];
    }

    const runs: [IntroMode, LinearShimmerDir | undefined][] = [];
    for (const mode of modes) for (const dir of dirs) runs.push([mode, dir]);

    process.stdout.write('\x1b[?25l');
    try {
        for (const [mode, dir] of runs) {
            await runOne(mode, dir);
            if (runs.length > 1) await new Promise((r) => setTimeout(r, 800));
        }
    } finally {
        // restore the cursor even on ctrl-c, or the terminal is left without one.
        process.stdout.write('\x1b[?25h\n');
    }
}

process.on('SIGINT', () => {
    process.stdout.write('\x1b[?25h\n');
    process.exit(130);
});

main();
