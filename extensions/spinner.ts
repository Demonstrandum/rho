// sets the working indicator and message.
//
// the indicator glyphs come from spinners.json, filtered to ENABLED_CATEGORIES
// (chinese by default). the message is a random line from maxims.txt, animated
// with a shimmer color-sweep, and a completion line is shown when the agent
// settles. both the maxim and the spinner are re-picked each turn.
//
// the shimmer sweep, glyphs, and completion line are adapted from
// pi-claude-shimmer by ouzhenkun (MIT), https://github.com/ouzhenkun/pi-claude-shimmer

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// edit to switch spinner sets. categories are defined per spinner in spinners.json.
const ENABLED_CATEGORIES = ['chinese'];

// shimmer palette (claude orange). base is the resting color, shimmer is the
// moving highlight. change to fit whatever theme you run.
const BASE_HEX = '#D77757';
const SHIMMER_HEX = '#F59575';
const SHIMMER_MS = 120;
const SHIMMER_BAND = 4;

// shown when the agent settles: "* <verb> for <duration>".
const COMPLETION_VERBS = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sauteed', 'Worked'];
const COMPLETION_GLYPH = '✻';

type Rgb = [number, number, number];

interface SpinnerDef {
    category: string;
    interval: number;
    frames: string[];
}

type SpinnersFile = Record<string, SpinnerDef>;

const here = dirname(fileURLToPath(import.meta.url));
const spinnersPath = join(here, 'spinners.json');
const maximsPath = join(here, 'maxims.txt');

function loadSpinners(): SpinnerDef[] {
    const file = JSON.parse(readFileSync(spinnersPath, 'utf8')) as SpinnersFile;
    const enabled = new Set(ENABLED_CATEGORIES);
    const all = Object.values(file);
    const pool = all.filter((spinner) => enabled.has(spinner.category));
    return pool.length > 0 ? pool : all;
}

function loadMaxims(): string[] {
    return readFileSync(maximsPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith(';'));
}

function pick<T>(items: T[]): T | undefined {
    return items.length > 0 ? items[Math.floor(Math.random() * items.length)] : undefined;
}

function hexToRgb(hex: string): Rgb {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
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
function colorSweep(text: string, frame: number): string {
    const base = hexToRgb(BASE_HEX);
    const shimmer = hexToRgb(SHIMMER_HEX);
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

    const render = () => {
        if (verb !== '') {
            ctx?.ui.setWorkingMessage(colorSweep(verb, frame));
        }
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
        const spinner = pick(loadSpinners());
        if (spinner !== undefined) {
            ctx.ui.setWorkingIndicator({
                frames: spinner.frames.map((f) => ansiFg(hexToRgb(BASE_HEX)) + f + RESET),
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
        const done = pick(COMPLETION_VERBS) ?? 'Worked';
        ctx?.ui.notify(`${COMPLETION_GLYPH} ${done} for ${formatDuration(elapsed)}`, 'info');
    });

    pi.on('session_shutdown', async () => {
        stopTimer();
        ctx = undefined;
    });
}
