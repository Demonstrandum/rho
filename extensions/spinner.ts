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
import { themeRgb, blend, ansiFg, RESET, type Rgb } from './lib/utils';

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

// completion line: "<sigil> <verb> <preposition> <duration>", e.g. "完 Toiled for 12s".
// the default sigil is 完 (done). a verb in verbs.txt may lead with a `[glyph]`
// token to swap it, e.g. "[₿] Mined Bitcoin" -> "₿ Mined Bitcoin for 12s", and
// may end with a `<preposition>` token to swap the default 'for', e.g.
// "Solved a Rubiks cube <in only>" -> "... in only 12s".
const COMPLETION_GLYPH = '完';
const COMPLETION_FALLBACK: Verb = { text: 'Toiled', preposition: 'for', trail: '', sigil: COMPLETION_GLYPH };

// the completion line renders through pi's status color (`dim`), which is low
// contrast against the background. both the text and the sigil blend from the
// theme's `text` color toward the high-contrast extreme (black on light themes,
// white on dark). 0 = plain text color, 1 = the pure extreme. the sigil sits
// further toward the extreme so it reads as the brightest mark on the line.
const COMPLETION_CONTRAST = 0.45;
const SIGIL_INTENSITY = 0.9;
// no-truecolor-anchor fallback in formatVerb: the verb text stays the theme's
// light `dim` color and the sigil is nudged this far from `dim` toward the
// dark/light extreme, a touch heavier than the verb but not full black. with no
// rgb at all the theme's own `dim`/`text` ansi escapes are used verbatim.
const SIGIL_FALLBACK_DARKEN = 0.4;
const SHIMMER_BAND = 4;

// how the frame list is played each loop. 'repeat' runs start -> end and jumps
// back to the start (the default, and pi's native behaviour). 'pulse' runs
// start -> end -> start, ping-ponging without repeating the endpoints.
type Animation = 'repeat' | 'pulse';

// frames may be written as an explicit array, or as a single string that is
// split into its codepoints (so CJK / astral glyphs each become one frame).
type RawFrames = string | string[];

export function toFrames(frames: RawFrames): string[] {
    return typeof frames === 'string' ? [...frames] : frames;
}

interface RawSpinnerDef {
    category: string;
    interval: number;
    frames: RawFrames;
    animation?: Animation;
}

interface SpinnerDef {
    category: string;
    interval: number;
    frames: string[];
    animation?: Animation;
}

// build one loop's worth of frames for the given animation. 'pulse' appends the
// interior frames in reverse so the jump back to frame 0 is itself a step.
export function playFrames(frames: string[], animation: Animation): string[] {
    if (animation === 'pulse' && frames.length > 2) {
        return frames.concat(frames.slice(1, -1).reverse());
    }
    return frames;
}

type SpinnersFile = Record<string, RawSpinnerDef>;

export interface Verb {
    text: string;
    preposition: string;
    trail: string;
    sigil: string;
}

const here = join(dirname(fileURLToPath(import.meta.url)), 'assets');
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
    const all = Object.values(file).map(
        (spinner): SpinnerDef => ({ ...spinner, frames: toFrames(spinner.frames) }),
    );
    const pool = all.filter((spinner) => enabled.has(spinner.category));
    return pool.length > 0 ? pool : all;
}

function loadMaxims(): string[] {
    return loadLines(maximsPath);
}

export function parseVerb(line: string): Verb {
    const sigilMatch = line.match(/^\s*\[([^\]]*)\]\s*(.*)$/);
    const sigil = (sigilMatch?.[1]?.trim() || COMPLETION_GLYPH);
    const rest = sigilMatch ? sigilMatch[2] : line;

    const match = rest.match(/^(.*?)\s*(?:<([^>]*)>\s*(.*?))?$/)!;

    const text        = match[1]?.trim() || COMPLETION_FALLBACK.text;
    const preposition = match[2]?.trim() || COMPLETION_FALLBACK.preposition;
    const trail       = match[3]?.trim() || COMPLETION_FALLBACK.trail;

    return { text, preposition, trail, sigil };
}

// build the completion line, coloring the sigil at full contrast and the rest
// at the softer blend so the sigil reads as the brightest mark. when there is
// no truecolor `text` anchor to blend from, fall back on the light `dim` color
// for the verb text and nudge the sigil `SIGIL_FALLBACK_DARKEN` of the way from
// `dim` toward the dark/light extreme, so it reads a touch heavier than the verb
// without collapsing to pure black. a theme like plan9 leaves `text` empty (the
// terminal default fg), which is why the fallback matters at all. with no rgb
// whatsoever (256-color mode) there is nothing to blend, so both marks keep the
// theme's own ansi escapes: the verb text on the light `dim` base and the sigil
// on the heavier `text` role, rather than collapsing to the plain terminal fg.
export function formatVerb(theme: Theme, verb: Verb, duration: number | string): string {
    duration = typeof duration === 'number' ? formatDuration(duration) : duration;
    const words = [verb.text, verb.preposition, duration];
    if (verb.trail) words.push(verb.trail);
    const rest = words.join(' ');

    const lum = (c: Rgb) => c[0] + c[1] + c[2];
    const dim = themeRgb(theme, 'dim');
    const text = themeRgb(theme, 'text');
    if (dim === undefined || text === undefined) {
        if (dim === undefined) {
            const sigilFg = theme.getFgAnsi('text');
            const restFg = theme.getFgAnsi('dim');
            return sigilFg + verb.sigil + RESET + ' ' + restFg + rest + RESET;
        }
        const toExtreme: Rgb = lum(dim) > (255 * 3) / 2 ? [0, 0, 0] : [255, 255, 255];
        const sigilFg = ansiFg(blend(dim, toExtreme, SIGIL_FALLBACK_DARKEN));
        return sigilFg + verb.sigil + RESET + ' ' + ansiFg(dim) + rest + RESET;
    }
    const extreme: Rgb = lum(text) < lum(dim) ? [0, 0, 0] : [255, 255, 255];
    const sigilFg = ansiFg(blend(text, extreme, SIGIL_INTENSITY));
    const restFg = ansiFg(blend(text, extreme, COMPLETION_CONTRAST));
    return sigilFg + verb.sigil + RESET + ' ' + restFg + rest + RESET;
}

function loadVerbs(): Verb[] {
    return loadLines(verbsPath).map(parseVerb);
}

// assets are read and parsed once at load; they never change mid-session, and
// /reload re-runs module init to pick up edits. pick() samples fresh each turn.
const SPINNERS = loadSpinners();
const MAXIMS = loadMaxims();
const VERBS = loadVerbs();

function pick<T>(items: T[]): T | undefined {
    return items.length > 0 ? items[Math.floor(Math.random() * items.length)] : undefined;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// an emoji grapheme is one carrying a pictographic codepoint or the emoji
// joiners (ZWJ / variation selector 16). such clusters are multi-codepoint
// (surrogate pairs, ZWJ sequences, skin-tone modifiers); coloring per code unit
// splits them and wrecks the terminal, so they are kept out of the sweep.
export function isEmojiCluster(cluster: string): boolean {
    return /\p{Extended_Pictographic}|[\u200D\uFE0F]/u.test(cluster);
}

// a moving highlight band across the text, returned as a per-grapheme ansi
// string. the text is segmented into grapheme clusters so multi-codepoint
// glyphs stay intact; emoji clusters render at the base color, outside the
// sweep, since interleaving color escapes through them corrupts the output.
export function colorSweep(text: string, frame: number, base: Rgb, shimmer: Rgb): string {
    const clusters = [...graphemes.segment(text)].map((s) => s.segment);
    const total = clusters.length + SHIMMER_BAND * 2;
    const pos = frame % total;
    let out = '';
    for (let i = 0; i < clusters.length; i++) {
        if (isEmojiCluster(clusters[i])) {
            out += ansiFg(base) + clusters[i];
            continue;
        }
        const t = Math.max(0, 1 - Math.abs(i - pos) / SHIMMER_BAND);
        out += ansiFg(blend(base, shimmer, t)) + clusters[i];
    }
    return out + RESET;
}

export function formatDuration(ms: number): string {
    const s = Math.round(ms / 1000);
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
        verb = pick(MAXIMS) ?? 'working';
        frame = 0;
        baseRgb = themeRgb(ctx.ui.theme, MAXIM_BASE);
        shimmerRgb = themeRgb(ctx.ui.theme, MAXIM_SHIMMER);
        const spinner = pick(SPINNERS);
        if (spinner !== undefined) {
            const played = playFrames(spinner.frames, spinner.animation ?? 'repeat');
            ctx.ui.setWorkingIndicator({
                frames: played.map((f) => ctx!.ui.theme.fg(SPINNER_COLOR, f)),
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
        const done = pick(VERBS) ?? COMPLETION_FALLBACK;
        if (ctx !== undefined) {
            ctx.ui.notify(formatVerb(ctx.ui.theme, done, elapsed), 'info');
        }
    });

    pi.on('session_shutdown', async () => {
        stopTimer();
        ctx = undefined;
    });
}
