// the text primitives every extension here was writing for itself.
//
// pure: no pi imports, no state, nothing but strings and numbers in and out.
// this is the layer under the prose modules: reflow.ts decides where a
// sentence ends and disenshittification.ts rewrites to the house style, while
// this file holds the small operations both of those, and every renderer,
// need. a function belongs here when two call sites would otherwise each
// write it, and the answer does not depend on where it is shown.
//
// five groups:
//   escapes   what a terminal line contains besides the text
//   fitting   making a string shorter, and saying so
//   counting  a number as a reader reads it
//   time      an interval and an instant, in words
//   names     an identifier as a phrase, a path as a reader knows it

import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// ---- escapes ----------------------------------------------------------

/** colour and style runs. */
export const SGR = /\x1b\[[0-9;]*m/g;
/** operating system commands: shell integration markers, image protocols. */
export const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** every escape sequence, of any kind, that occupies no columns. */
export const ESCAPE = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** the line as the reader sees it: escapes removed, characters kept. */
export function plain(text: string): string {
    return text.replace(ESCAPE, '');
}

/** how many columns a styled line occupies. */
export function visibleWidth(text: string): number {
    return plain(text).length;
}

/** nothing but escapes and whitespace, so the line draws as empty. */
export function isBlank(text: string): boolean {
    return plain(text).trim() === '';
}

interface Span {
    text: string;
    visible: boolean;
}

/** a styled line split into what prints and what does not. */
export function spans(line: string): Span[] {
    const out: Span[] = [];
    let at = 0;
    ESCAPE.lastIndex = 0;
    for (let match = ESCAPE.exec(line); match !== null; match = ESCAPE.exec(line)) {
        if (match.index > at) out.push({ text: line.slice(at, match.index), visible: true });
        out.push({ text: match[0], visible: false });
        at = match.index + match[0].length;
    }
    if (at < line.length) out.push({ text: line.slice(at), visible: true });
    return out;
}

/**
 * replace the visible characters in [start, end) with `replacement`, keeping
 * every escape sequence where it was. the replacement therefore inherits the
 * styling of the text it stands in for, which is what a caller renaming
 * something inside a line someone else rendered wants.
 */
export function spliceVisible(line: string, start: number, end: number, replacement: string): string {
    const out: string[] = [];
    let seen = 0;
    let placed = false;
    for (const span of spans(line)) {
        if (!span.visible) {
            out.push(span.text);
            continue;
        }
        const from = seen;
        const to = seen + span.text.length;
        seen = to;
        if (to <= start || from >= end) {
            out.push(span.text);
            continue;
        }
        const head = span.text.slice(0, Math.max(0, start - from));
        const tail = span.text.slice(Math.max(0, Math.min(span.text.length, end - from)));
        out.push(head + (placed ? '' : replacement) + tail);
        placed = true;
    }
    return out.join('');
}

// ---- fitting ----------------------------------------------------------

export const ELLIPSIS = '\u2026';
/** an omission standing where a token was, rather than after one. */
export const BRACKET = `[${ELLIPSIS}]`;

/** every run of whitespace, including newlines, becomes one space. */
export function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** cut to `budget` columns, the last of them spent on the marker. */
export function truncate(text: string, budget: number, marker = ELLIPSIS): string {
    if (text.length <= budget) return text;
    if (budget <= marker.length) return marker.slice(0, Math.max(0, budget));
    return text.slice(0, budget - marker.length) + marker;
}

/** one line of a multi-line value, for a list or a picker row. */
export function preview(text: string, budget: number, marker = '...'): string {
    return truncate(oneLine(text), budget, marker);
}

/**
 * keep the head and say what was dropped. for text an agent reads, where a
 * silent cut is how it reads half a log and concludes the wrong thing.
 */
export function omitTail(text: string, limit: number, unit = 'characters'): string {
    const trimmed = text.trim();
    if (trimmed.length <= limit) return trimmed;
    return `${trimmed.slice(0, limit)}\n[...${trimmed.length - limit} ${unit} omitted]`;
}

/**
 * keep the tail of a path: /a/b/c/pi-coding-agent/dist -> [...]/pi-coding-agent/dist.
 * segments are taken from the end until they carry `minTail` characters, so a
 * generic last segment (dist, src, build) keeps its parent.
 */
export function elidePath(token: string, max = 20, minTail = 12): string {
    if (token.length <= max || !token.includes('/')) return token;
    const segments = token.split('/').filter((s) => s !== '');
    const tail: string[] = [];
    for (let i = segments.length - 1; i >= 0; i--) {
        tail.unshift(segments[i]!);
        if (tail.join('/').length >= minTail) break;
    }
    if (tail.length >= segments.length) return token;
    return `${BRACKET}/${tail.join('/')}`;
}

// ---- counting ---------------------------------------------------------

/** an English plural, with the irregular form given where -s is wrong. */
export function plural(count: number, singular: string, many = `${singular}s`): string {
    return count === 1 ? singular : many;
}

/** "1 conversation", "3 conversations". */
export function quantity(count: number, singular: string, many?: string): string {
    return `${count} ${plural(count, singular, many)}`;
}

/** "a", "a and b", "a, b and c". the serial comma stays, per p5.(i). */
export function series(items: readonly string[], conjunction = 'and'): string {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0]!;
    if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1]}`;
}

/**
 * how much of the magnitude is kept. `compact` spends a decimal only where the
 * value is under ten units and keeps it when it is zero, which is what a
 * status line of fixed columns wants; `fine` always offers a decimal and drops
 * a trailing zero, which is what a readout reads better with.
 */
export type Grain = 'compact' | 'fine';

const UNITS: readonly { at: number; suffix: string }[] = [
    { at: 1e6, suffix: 'M' },
    { at: 1e3, suffix: 'k' },
];

/** 1500 -> "1.5k"; 15234 -> "15k" compact, "15.2k" fine; 2000 -> "2.0k" compact, "2k" fine. */
export function abbreviate(value: number, grain: Grain = 'compact'): string {
    for (const unit of UNITS) {
        if (Math.abs(value) < unit.at) continue;
        const scaled = value / unit.at;
        if (grain === 'fine') return `${Number(scaled.toFixed(1))}${unit.suffix}`;
        return `${scaled.toFixed(Math.abs(scaled) < 10 ? 1 : 0)}${unit.suffix}`;
    }
    return String(value);
}

/** a share as a percentage, to one decimal. an empty whole is 0.0. */
export function percent(part: number, whole: number, decimals = 1): string {
    return (whole > 0 ? (part / whole) * 100 : 0).toFixed(decimals);
}

// ---- time -------------------------------------------------------------

/** an elapsed interval: "45s", "3m 20s". */
export function duration(ms: number): string {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** how long ago an instant was: "12s ago", "4h ago", "2d ago". */
export function ago(at: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

// ---- names ------------------------------------------------------------

/**
 * an identifier as the words it is made of: `ctx_execute_file`,
 * `mcp__brave__search`, `webSearch`, `claude-opus-4-8`.
 */
export function words(identifier: string): string[] {
    return identifier
        .split(/__+|[_\-.\s]+/)
        .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
        .filter((word) => word !== '');
}

export function capitalise(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * an absolute path under the home directory, written the way it is typed. a
 * path outside it is left as it is, rather than given a `..` chain nobody
 * reads.
 */
export function collapseHome(path: string, home: string | undefined = homedir()): string {
    if (home === undefined || home === '') return path;
    const rel = relative(resolve(home), resolve(path));
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!inside) return path;
    return rel === '' ? '~' : `~${sep}${rel}`;
}
