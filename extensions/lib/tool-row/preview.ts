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

import { ELLIPSIS, oneLine, truncate, visibleWidth } from '../text';
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
/** the mark that the body goes on past the line shown. */
const MORE = ` ${ELLIPSIS}`;

/**
 * a word that only joins a confirmation to the thing already named on the call
 * line. "Sent to D0C0PG7LZCJ." minus the identifier is "Sent to", and the
 * preposition goes with it.
 */
const DANGLING = /\s+(?:to|in|on|at|for|from|with)\s*$/i;

/**
 * a result left saying only that it worked. the row is already the record that
 * the call happened and its colour is the record that it worked, so a word to
 * that effect is a second copy of both.
 */
const CONFIRMATION = /^(?:sent|done|ok|okay|closed|saved|posted|uploaded|written|created|updated|removed|deleted|complete|completed|success|succeeded)$/i;

export interface ResultPreviewOptions {
    /** the raw result text of the tool. */
    text: string;
    /** the arguments the call was made with, to know what it already said. */
    args: unknown;
    note?: string;
    expanded: boolean;
    width: number;
    theme?: RowTheme;
}

/**
 * the result row of a tool that draws none of its own.
 *
 * a tool that acts on something usually answers by naming it again: the call
 * says who was written to and the result says it was sent to the same
 * identifier. what the call already carries is removed, and a result left with
 * nothing of its own is dropped, because the row is the record that it
 * happened and its colour is the record that it worked. anything the call did
 * not say survives, which is what a refusal is.
 */
export function resultPreview(options: ResultPreviewOptions): string[] {
    const { text, args, note, expanded, width } = options;
    const theme = options.theme ?? PLAIN_THEME;
    const lines = text.split('\n');
    if (expanded) return lines.map((line) => theme.fg('toolOutput', line));

    const summary = summariseArgs(args);
    const said = [summary.subject?.value, note, summary.body].filter((part): part is string => part !== undefined);
    let rest = oneLine(lines[0] ?? '');
    for (const part of said) rest = rest.split(part).join('');
    rest = oneLine(rest).replace(/[\s.,:;]+$/, '').replace(DANGLING, '').replace(/^[\s.,:;]+/, '');
    if (rest === '' || CONFIRMATION.test(rest)) return [];
    return [theme.fg('muted', truncate(rest, Math.max(8, width)))];
}

export interface CallPreviewOptions {
    title: string;
    args: unknown;
    /** what the subject is, in words: a person's name for a channel ID. */
    note?: string;
    /** the machine the call acted on, shown when it is not the session's own. */
    where?: string;
    expanded: boolean;
    width: number;
    theme?: RowTheme;
}

/**
 * what the row calls its subject. a name is what the reader knows the thing
 * by, so it takes the subject's place and the identifier behind it is shown
 * only on expand, where the rest of the arguments are.
 */
function subjectText(subject: ArgEntry, note: string | undefined, expanded: boolean): string {
    if (note === undefined) return subject.value;
    return expanded ? `${note} (${subject.value})` : note;
}

/**
 * the lines of a call row: the title and its subject, then the text the call
 * carries. collapsed, the text is its first line; expanded, all of it, with
 * the arguments neither of those showed under it.
 */
export function callPreview(options: CallPreviewOptions): string[] {
    const { title, args, note, expanded, width, where } = options;
    const theme = options.theme ?? PLAIN_THEME;
    const summary = summariseArgs(args);

    let head = theme.fg('toolTitle', theme.bold(title));
    let used = title.length;
    if (summary.subject !== undefined) {
        const preposition = PREPOSITION[summary.subject.key];
        const budget = Math.max(8, width - used - (preposition ? preposition.length + 2 : 1));
        const value = truncate(subjectText(summary.subject, note, expanded), budget);
        if (preposition !== undefined) {
            head += ' ' + theme.fg('dim', preposition);
            used += preposition.length + 1;
        }
        head += ' ' + theme.fg('accent', value);
        used += value.length + 1;
    }

    const lines = [head];
    if (summary.body !== undefined) {
        const body = expanded ? summary.body.split('\n') : [summary.body.split('\n')[0] ?? ''];
        const clipped = !expanded && summary.body.includes('\n');
        // the mark prints on the same line, so its columns come out of the text's
        // budget. a line one column over the terminal width crashes pi outright.
        const budget = Math.max(1, width - QUOTE.length - (clipped ? MORE.length : 0));
        const shown = expanded ? body : body.map((line) => truncate(line, budget));
        for (const line of shown) lines.push(theme.fg('dim', QUOTE) + theme.fg('toolOutput', line));
        if (clipped) lines[lines.length - 1] += theme.fg('dim', MORE);
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

    // the machine the call acted on, on the right of the first line, and only
    // when it is not the one the session points at. a command that ran
    // elsewhere is otherwise identical on screen to one that did not, and its
    // output is the only clue. right-aligned because the command is what the
    // eye wants first and this is an aside.
    if (where !== undefined && where !== '') {
        // The tag's columns are reserved before the line is measured, because
        // the subject may already fill the row: appending to a full line is
        // how a rendered line exceeds the terminal, which crashes pi. On a
        // narrow terminal the tag is shortened too, since a host name can be
        // longer than the whole row.
        const tag = truncate(`(${where})`, Math.max(4, width - 10));
        const room = Math.max(4, width - visibleWidth(tag) - 1);
        const first = truncate(lines[0] ?? '', room);
        const pad = Math.max(1, width - visibleWidth(first) - visibleWidth(tag));
        lines[0] = `${first}${' '.repeat(pad)}${theme.fg('dim', tag)}`;
    }
    return lines;
}
