// sets the working indicator and message.
//
// the indicator glyphs come from spinners.json, filtered to ENABLED_CATEGORIES
// (chinese by default). the message is a random line from maxims.txt, animated
// with a shimmer color-sweep, and a completion line (a random verb from
// verbs.txt) is shown when the agent settles. both the maxim and the spinner
// are re-picked each turn.
//
// the shimmer sweep, glyphs, and completion line are adapted from
// pi-claude-shimmer by ouzhenkun (MIT), https://github.com/ouzhenkun/pi-claude-shimmer

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';

// edit to switch spinner sets. categories are defined per spinner in spinners.json.
const ENABLED_CATEGORIES = ['chinese'];

// colors come from the active theme, matching pi's native loader: the spinner is
// the bright `accent`, the maxim rests on neutral `muted` and the shimmer sweeps
// up toward `accent`. edit these to point at different theme roles.
const SPINNER_COLOR: ThemeColor = 'accent';
const MAXIM_BASE: ThemeColor = 'muted';
const MAXIM_SHIMMER: ThemeColor = 'accent';
const SHIMMER_MS = 80;
// frames per trailing-dot step; the maxim grows '.' '..' '...' then repeats.
const DOTS_STEP = 1;
const DOTS_MAX = 3;
const SHIMMER_BAND = 4;

// completion line: "完 <verb> <preposition> <duration>", e.g. "完 Toiled for 12s".
// 完 = done. a verb in verbs.txt may end with a `<preposition>` token to swap the
// default 'for', e.g. "Solved a Rubiks cube <in only>" -> "... in only 12s".
const COMPLETION_GLYPH = '完';
const COMPLETION_FALLBACK: Verb = { text: 'Toiled', preposition: 'for' };

type Rgb = [number, number, number];

interface SpinnerDef {
    category: string;
    interval: number;
    frames: string[];
}

type SpinnersFile = Record<string, SpinnerDef>;

interface Verb {
    text: string;
    preposition: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const spinnersPath = join(here, 'spinners.json');
const maximsPath = join(here, 'maxims.txt');
const verbsPath = join(here, 'verbs.txt');

function loadLines(path: string): string[] {
    return readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith(';'));
}

function loadSpinners(): SpinnerDef[] {
    const file = JSON.parse(readFileSync(spinnersPath, 'utf8')) as SpinnersFile;
    const enabled = new Set(ENABLED_CATEGORIES);
    const all = Object.values(file);
    const pool = all.filter((spinner) => enabled.has(spinner.category));
    return pool.length > 0 ? pool : all;
}

function loadMaxims(): string[] {
    return loadLines(maximsPath);
}

function parseVerb(line: string): Verb {
    const match = line.match(/^(.*?)\s*<([^>]+)>\s*$/);
    return match ? { text: match[1].trim(), preposition: match[2].trim() } : { text: line, preposition: 'for' };
}

function loadVerbs(): Verb[] {
    return loadLines(verbsPath).map(parseVerb);
}

function pick<T>(items: T[]): T | undefined {
    return items.length > 0 ? items[Math.floor(Math.random() * items.length)] : undefined;
}

// pull the truecolor rgb behind a theme role, if the theme emits one. themes in
// 256-color mode emit palette indices instead, in which case shimmer blending is
// skipped and the maxim falls back to a flat themed color.
function themeRgb(theme: Theme, color: ThemeColor): Rgb | undefined {
    const match = theme.getFgAnsi(color).match(/38;2;(\d+);(\d+);(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function blend(a: Rgb, b: Rgb, t: number): Rgb {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ];
}

function ansiFg(rgb: Rgb): string {
    return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

const RESET = '\x1b[0m';

// a moving highlight band across the text, returned as a per-character ansi string.
function colorSweep(text: string, frame: number, base: Rgb, shimmer: Rgb): string {
    const total = text.length + SHIMMER_BAND * 2;
    const pos = frame % total;
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const t = Math.max(0, 1 - Math.abs(i - pos) / SHIMMER_BAND);
        out += ansiFg(blend(base, shimmer, t)) + text[i];
    }
    return out + RESET;
}

function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export default function (pi: ExtensionAPI) {
    let ctx: ExtensionContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let frame = 0;
    let verb = '';
    let agentStart = 0;
    let baseRgb: Rgb | undefined;
    let shimmerRgb: Rgb | undefined;

    const render = () => {
        if (verb === '' || ctx === undefined) {
            return;
        }
        const dots = '.'.repeat((Math.floor(frame / DOTS_STEP) % (DOTS_MAX + 1)));
        const message =
            baseRgb !== undefined && shimmerRgb !== undefined
                ? colorSweep(verb, frame, baseRgb, shimmerRgb) + ansiFg(baseRgb) + dots + RESET
                : ctx.ui.theme.fg(MAXIM_BASE, verb + dots);
        ctx.ui.setWorkingMessage(message);
    };

    const ensureTimer = () => {
        if (timer !== undefined) {
            return;
        }
        timer = setInterval(() => {
            frame++;
            render();
        }, SHIMMER_MS);
    };

    const stopTimer = () => {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };

    const beginTurn = (next: ExtensionContext) => {
        ctx = next;
        verb = pick(loadMaxims()) ?? 'working';
        frame = 0;
        baseRgb = themeRgb(ctx.ui.theme, MAXIM_BASE);
        shimmerRgb = themeRgb(ctx.ui.theme, MAXIM_SHIMMER);
        const spinner = pick(loadSpinners());
        if (spinner !== undefined) {
            ctx.ui.setWorkingIndicator({
                frames: spinner.frames.map((f) => ctx!.ui.theme.fg(SPINNER_COLOR, f)),
                intervalMs: spinner.interval,
            });
        }
        render();
        ensureTimer();
    };

    pi.on('session_start', async (_event, next) => {
        ctx = next;
    });

    pi.on('agent_start', async (_event, next) => {
        ctx = next;
        if (agentStart === 0) {
            agentStart = Date.now();
        }
        if (verb === '') {
            beginTurn(next);
        } else {
            ensureTimer();
        }
    });

    pi.on('turn_start', async (_event, next) => {
        beginTurn(next);
    });

    pi.on('agent_end', async () => {
        stopTimer();
        const elapsed = Date.now() - (agentStart || Date.now());
        agentStart = 0;
        verb = '';
        const done = pick(loadVerbs()) ?? COMPLETION_FALLBACK;
        ctx?.ui.notify(`${COMPLETION_GLYPH} ${done.text} ${done.preposition} ${formatDuration(elapsed)}`, 'info');
    });

    pi.on('session_shutdown', async () => {
        stopTimer();
        ctx = undefined;
    });
}
