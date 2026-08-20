#!/usr/bin/env bun
// preview of the startup logo animation.
//   bun run demo/preview-animation.ts        all modes
//   bun run demo/preview-animation.ts rho    one mode
//
// the animation lives in extensions/lib/pi-logo.ts and is imported, not
// copied, so this preview always shows what a real session shows.

import {
    LOGO_W, LOGO_H, CENTER_ROW,
    DEFAULT_INTRO_MS, FRAME_MS, TYPE_PER_CHAR_MS, CURSOR_TAIL_MS,
    FADE_RAMP, FADE_DARK, SHIMMER_HIGHLIGHT_MIX, SHIMMER_DIRS,
    type IntroMode, type ShimmerDir, type Timeline,
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

function runOne(mode: IntroMode): Promise<void> {
    const randomDir = SHIMMER_DIRS[Math.floor(Math.random() * SHIMMER_DIRS.length)];
    const dir = shimmerDirFor(mode, randomDir);
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
            process.stdout.write(`${DIM}  [${mode}]${RESET}\n`);
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

const ALL_MODES: IntroMode[] = ['fade', 'build', 'scatter', 'pi', 'rho'];

// 'pirho' was the old name for the two-trace mode, now 'rho'.
function parseArg(arg: string | undefined): IntroMode | undefined {
    if (arg === undefined) return undefined;
    const name = arg === 'pirho' ? 'rho' : arg;
    return ALL_MODES.includes(name as IntroMode) ? (name as IntroMode) : undefined;
}

async function main() {
    const requested = parseArg(process.argv[2]?.toLowerCase());
    const modes = requested ? [requested] : ALL_MODES;

    process.stdout.write('\x1b[?25l');
    for (const mode of modes) {
        await runOne(mode);
        if (modes.length > 1) await new Promise((r) => setTimeout(r, 800));
    }
    process.stdout.write('\x1b[?25h\n');
}

main();
