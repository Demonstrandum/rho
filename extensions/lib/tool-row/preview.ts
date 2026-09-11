// the call row of a tool that draws none of its own: what it acts on, and the
// text it carries.
//
// pure: no pi imports. a renderer feeds it a title, the raw arguments, a width
// and a theme, and gets back styled lines. exec.ts is the same job for the
// three tools whose argument is source code, where a shortened command is
// worth the parsing; this is every other tool, where the arguments say what
// happened as they are.
//
// the arguments are sorted rather than dumped: one of them is the subject (a
// channel, a path, a URL), one is the text the call carries (a message, a
// query), and the rest are named on expand. a tool this file has never heard
// of falls through to its arguments spelled out, which is still shorter than
// the JSON block pi would print.

import { truncate } from '../text';
import { PLAIN_THEME, type RowTheme } from './theme';

export interface ArgEntry {
    key: string;
    value: string;
}

export interface ArgSummary {
    /** what the call acts on: a channel, a path, a URL. */
    subject?: ArgEntry;
    /** the text the call carries: a message, a query, a patch. */
    body?: string;
    /** the remaining scalar arguments, in the order they were given. */
    rest: ArgEntry[];
}

/** argument names that name the call's subject, most specific first. */
const SUBJECT_KEYS = [
    'file_path', 'path', 'url', 'channel', 'target', 'host', 'session', 'name', 'id', 'command', 'pattern',
] as const;

/** argument names that carry the call's text. */
const BODY_KEYS = ['text', 'message', 'comment', 'body', 'content', 'code', 'prompt', 'query', 'description'] as const;

/** the preposition placed before a subject of this kind, if any. */
const PREPOSITION: Readonly<Record<string, string>> = {
    channel: 'to',
    target: 'to',
    host: 'on',
    session: 'in',
};

function scalar(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        const parts = value.map(scalar).filter((part): part is string => part !== undefined);
        return parts.length === value.length ? parts.join(', ') : `${value.length} items`;
    }
    return undefined;
}

export function summariseArgs(args: unknown): ArgSummary {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return { rest: [] };
    const table = args as Record<string, unknown>;
    const taken = new Set<string>();

    let subject: ArgEntry | undefined;
    for (const key of SUBJECT_KEYS) {
        const value = table[key];
        if (typeof value === 'string' && value !== '') {
            subject = { key, value };
            taken.add(key);
            break;
        }
    }

    let body: string | undefined;
    for (const key of BODY_KEYS) {
        if (taken.has(key)) continue;
        const value = table[key];
        if (typeof value === 'string' && value !== '') {
            body = value;
            taken.add(key);
            break;
        }
    }

    const rest: ArgEntry[] = [];
    for (const [key, value] of Object.entries(table)) {
        if (taken.has(key)) continue;
        const rendered = scalar(value);
        if (rendered === undefined || rendered === '') continue;
        rest.push({ key, value: rendered });
    }
    return { subject, body, rest };
}

const QUOTE = '> ';

export interface CallPreviewOptions {
    title: string;
    args: unknown;
    /** what the subject is, in words: a person's name for a channel ID. */
    note?: string;
    expanded: boolean;
    width: number;
    theme?: RowTheme;
}

/**
 * the lines of a call row: the title and its subject, then the text the call
 * carries. collapsed, the text is its first line; expanded, all of it, with
 * the arguments neither of those showed under it.
 */
export function callPreview(options: CallPreviewOptions): string[] {
    const { title, args, note, expanded, width } = options;
    const theme = options.theme ?? PLAIN_THEME;
    const summary = summariseArgs(args);

    let head = theme.fg('toolTitle', theme.bold(title));
    let used = title.length;
    if (summary.subject !== undefined) {
        const preposition = PREPOSITION[summary.subject.key];
        const budget = Math.max(8, width - used - (preposition ? preposition.length + 2 : 1) - (note ? note.length + 3 : 0));
        const value = truncate(summary.subject.value, budget);
        if (preposition !== undefined) {
            head += ' ' + theme.fg('dim', preposition);
            used += preposition.length + 1;
        }
        head += ' ' + theme.fg('accent', value);
        used += value.length + 1;
        if (note !== undefined) {
            head += ' ' + theme.fg('muted', `(${note})`);
            used += note.length + 3;
        }
    }

    const lines = [head];
    if (summary.body !== undefined) {
        const body = expanded ? summary.body.split('\n') : [summary.body.split('\n')[0] ?? ''];
        const budget = Math.max(8, width - QUOTE.length);
        const shown = expanded ? body : body.map((line) => truncate(line, budget));
        const clipped = !expanded && summary.body.includes('\n');
        for (const line of shown) lines.push(theme.fg('dim', QUOTE) + theme.fg('toolOutput', line));
        if (clipped) lines[lines.length - 1] += theme.fg('dim', ' \u2026');
    }

    if (expanded) {
        for (const entry of summary.rest) {
            lines.push(theme.fg('muted', `${entry.key}: `) + theme.fg('dim', entry.value));
        }
    } else if (summary.rest.length > 0 && summary.subject === undefined && summary.body === undefined) {
        // nothing else identifies the call, so the arguments themselves do.
        const text = summary.rest.map((entry) => `${entry.key}=${entry.value}`).join(' ');
        lines[0] += ' ' + theme.fg('dim', truncate(text, Math.max(8, width - used - 1)));
    }
    return lines;
}
