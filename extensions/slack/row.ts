// what a Slack tool row says it did.
//
// pure: no pi imports. a renderer feeds it the call's arguments, the text the
// tool answered with, a width and a theme, and gets back styled lines.
//
// the generic row (tool-row/preview.ts) reads a tool's arguments without
// knowing what they mean: it finds a subject, quotes the text, and hides the
// rest until the row is opened. That is right for a tool it has never seen and
// wrong for these, where the argument that says what happened is `action`:
// a reaction, a deletion and a permalink all came out as "slack manage message
// to Samuel", and the result line came out as "Sent to as 1731000000.000100",
// which is the tool's own sentence with the identifier cut out of the middle.
//
// so each Slack tool describes its own row here. the shape is the same in
// every case: a verb, what it acted on, and the text it carried, with the
// identifiers held back for the expanded row.

import type { RowTheme } from '../lib/tool-row/theme';
import { truncate } from '../lib/core/text';

/** how a channel id is written for a person: their name, or the id. */
export type Named = (id: string) => string;

export interface RowContext {
    readonly theme: RowTheme;
    readonly width: number;
    readonly expanded: boolean;
    /** what an id stands for, from tool-row/notes.ts in a session. */
    readonly named: Named;
}

/**
 * a row before it is styled.
 *
 * `verb` is what happened, and is the only part in the title's colour. `object`
 * is what it happened to. `body` is text the call carried, quoted under it.
 * `detail` is what only the expanded row shows: the ids behind the names.
 */
interface Row {
    readonly verb: string;
    readonly object?: string;
    readonly body?: string;
    readonly detail?: readonly string[];
}

const QUOTE = '> ';

/** hh:mm of a Slack timestamp, in UTC, which is how a message is named here. */
export function clock(ts: string): string {
    const at = Number.parseFloat(ts);
    if (!Number.isFinite(at)) return ts;
    return new Date(at * 1000).toISOString().slice(11, 16);
}

const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;

const count = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

/**
 * "Samuel", "#robotics", or the id.
 *
 * A DM is the person it is with, and there is nothing else to call it. Any
 * other conversation is named where the session learnt a name for it.
 */
function place(channel: string | undefined, named: Named): string | undefined {
    if (channel === undefined) return undefined;
    return named(channel);
}

/** "Samuel's 17:05 message", or "the 17:05 message in #robotics". */
function messageAt(ts: string | undefined, channel: string | undefined, named: Named, mine: boolean): string {
    const when = ts === undefined ? 'a' : clock(ts);
    const who = place(channel, named);
    if (who === undefined) return `the ${when} message`;
    if (channel?.startsWith('D') === true) return mine ? `your ${when} message to ${who}` : `${who}'s ${when} message`;
    return `the ${when} message in ${who}`;
}

/** an id Slack hands out, which is what a listing line opens with and no reader knows by sight. */
const ID = /^(?:[UWCDGQ][A-Z0-9]{4,}|dm)$/;

/**
 * what one entry of a listing is called.
 *
 * The entries are written for the model, which is given every id: "U09L8EEPUTC
 * dm D0A1B2C3D4E Mathis Wellmann (Europe/Berlin)". The row wants the part a
 * person reads, so the ids are dropped from the front and the marks in
 * parentheses from the end.
 */
function label(line: string): string {
    const words = line.trim().split(/\s+/);
    while (words.length > 1 && ID.test(words[0] as string)) words.shift();
    const rest = words.join(' ');
    const marks = rest.indexOf(' (');
    return (marks < 0 ? rest : rest.slice(0, marks)).trim();
}

/**
 * as many entries as the row holds, and a count of what is left.
 *
 * "Mathis Wellmann, Samuel, [6 more]" says what was found; "8 people" says how
 * many, which the expanded row would have said anyway.
 */
function series(labels: readonly string[], width: number, theme: RowTheme): string {
    const shown: string[] = [];
    let used = 0;
    for (const entry of labels) {
        const cost = used === 0 ? entry.length : entry.length + 2;
        // the tail is only reserved while entries remain that it would count.
        const tail = shown.length + 1 < labels.length ? ` [${labels.length - shown.length - 1} more]`.length : 0;
        if (used + cost + tail > width && shown.length > 0) break;
        shown.push(entry);
        used += cost;
    }
    if (shown.length === 0) return theme.fg('toolOutput', truncate(labels[0] ?? '', width));
    const left = labels.length - shown.length;
    const listed = theme.fg('toolOutput', truncate(shown.join(', '), width));
    return left === 0 ? listed : `${listed}${theme.fg('dim', ` [${left} more]`)}`;
}

/** the emoji as Slack writes it, colons included. */
const emojiOf = (value: unknown): string => {
    const name = text(value);
    return name === undefined ? '' : `:${name.replace(/:/g, '')}:`;
};

function describeManage(args: Record<string, unknown>, named: Named): Row {
    const ts = text(args.ts);
    const channel = text(args.channel);
    const ids = [ts === undefined ? undefined : `ts ${ts}`, channel].filter((id): id is string => id !== undefined);
    switch (text(args.action)) {
        case 'react':
            return { verb: 'slack react', object: `${emojiOf(args.emoji)} to ${messageAt(ts, channel, named, false)}`, detail: ids };
        case 'unreact':
            return {
                verb: 'slack unreact',
                object: `${emojiOf(args.emoji)} from ${messageAt(ts, channel, named, false)}`,
                detail: ids,
            };
        case 'reactions':
            return { verb: 'slack reactions', object: `on ${messageAt(ts, channel, named, false)}`, detail: ids };
        case 'update':
            return {
                verb: 'slack edit',
                object: messageAt(ts, channel, named, true),
                body: text(args.text),
                detail: ids,
            };
        case 'delete':
            return { verb: 'slack delete', object: messageAt(ts, channel, named, true), detail: ids };
        case 'permalink':
            return { verb: 'slack link', object: messageAt(ts, channel, named, false), detail: ids };
        default:
            return { verb: 'slack message', object: messageAt(ts, channel, named, false), detail: ids };
    }
}

function describeSchedule(args: Record<string, unknown>, named: Named): Row {
    const channel = text(args.channel);
    const action = text(args.action) ?? 'send';
    if (action === 'list') return { verb: 'slack scheduled', object: place(channel, named) };
    if (action === 'cancel') {
        return { verb: 'slack unschedule', object: text(args.id), detail: [channel].filter((id): id is string => id !== undefined) };
    }
    // "+8h" is how it is passed and not how it is read.
    const when = text(args.when)?.replace(/^\+/, '');
    const who = place(channel, named);
    const object = [when === undefined ? undefined : `in ${when}`, who === undefined ? undefined : `to ${who}`]
        .filter((part): part is string => part !== undefined)
        .join(' ');
    return {
        verb: 'slack schedule',
        object: object === '' ? undefined : object,
        body: text(args.text),
        detail: [channel].filter((id): id is string => id !== undefined),
    };
}

function describeDirectory(args: Record<string, unknown>, named: Named): Row {
    const user = text(args.user);
    if (user !== undefined) return { verb: 'slack directory', object: named(user), detail: [user] };
    const channel = text(args.channel);
    if (channel !== undefined) return { verb: 'slack directory', object: named(channel), detail: [channel] };
    const kind = text(args.kind) ?? 'conversations';
    const query = text(args.query);
    return { verb: 'slack directory', object: query === undefined ? kind : `${kind} matching "${query}"` };
}

/** what a call did, as a row, or null for a tool with no row of its own here. */
function describe(tool: string, args: Record<string, unknown>, named: Named): Row | null {
    const channel = text(args.channel);
    switch (tool) {
        case 'slack_reply': {
            const thread = text(args.thread);
            const who = place(channel, named);
            return {
                verb: 'slack reply',
                object: [who === undefined ? undefined : `to ${who}`, thread === undefined ? undefined : 'in thread']
                    .filter((part): part is string => part !== undefined)
                    .join(' '),
                body: text(args.text),
                detail: [channel, thread === undefined ? undefined : `thread ${thread}`].filter(
                    (id): id is string => id !== undefined,
                ),
            };
        }
        case 'slack_send_file': {
            const path = text(args.path) ?? '';
            const file = path.slice(path.lastIndexOf('/') + 1);
            const who = place(channel, named);
            return {
                verb: 'slack file',
                object: who === undefined ? file : `${file} to ${who}`,
                body: text(args.comment),
                detail: [path, channel].filter((id): id is string => id !== undefined),
            };
        }
        case 'slack_read': {
            const thread = text(args.thread);
            const limit = count(args.limit);
            const who = place(channel, named);
            return {
                verb: 'slack read',
                object: [
                    thread === undefined ? who : `the thread in ${who ?? 'this conversation'}`,
                    limit === undefined ? undefined : `(${limit})`,
                ]
                    .filter((part): part is string => part !== undefined)
                    .join(' '),
                detail: [channel, thread === undefined ? undefined : `thread ${thread}`].filter(
                    (id): id is string => id !== undefined,
                ),
            };
        }
        case 'slack_done':
            return { verb: 'slack done' };
        case 'slack_directory':
            return describeDirectory(args, named);
        case 'slack_manage_message':
            return describeManage(args, named);
        case 'slack_schedule':
            return describeSchedule(args, named);
        default:
            return null;
    }
}

function style(row: Row, context: RowContext): string[] {
    const { theme, width, expanded } = context;
    const head = [theme.fg('toolTitle', theme.bold(row.verb))];
    if (row.object !== undefined && row.object !== '') {
        head.push(theme.fg('accent', truncate(row.object, Math.max(8, width - row.verb.length - 1))));
    }
    const lines = [head.join(' ')];

    if (row.body !== undefined) {
        const body = expanded ? row.body.split('\n') : [row.body.split('\n')[0] ?? ''];
        const budget = Math.max(1, width - QUOTE.length);
        for (const line of body) {
            lines.push(theme.fg('dim', QUOTE) + theme.fg('toolOutput', expanded ? line : truncate(line, budget)));
        }
    }

    if (expanded && row.detail !== undefined) {
        for (const id of row.detail) lines.push(theme.fg('dim', id));
    }
    return lines;
}

/** the call row of a Slack tool, or null where this module has nothing to say. */
export function slackCall(tool: string, args: unknown, context: RowContext): string[] | null {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    const row = describe(tool, args as Record<string, unknown>, context.named);
    return row === null ? null : style(row, context);
}

/**
 * what a call answered, when that is more than a confirmation.
 *
 * A row's colour is the record that the call worked, and the call line already
 * says what it acted on, so "Sent to D0C2SA7A1EY as 1731000000.000100" adds a
 * timestamp nobody reads. What survives is an answer the call could not
 * predict: a refusal, a permalink, a listing, the messages that were read.
 */
export function slackResult(tool: string, args: unknown, answer: string, context: RowContext): string[] | null {
    const { theme, width, expanded } = context;
    const table = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    const lines = answer.split('\n').filter((line) => line !== '');
    const first = lines[0] ?? '';

    const refusal = /^(Slack refused it|No channel|Cannot|update needs|cancel needs|send needs|Slack is not attached)/;
    if (refusal.test(first)) {
        return [theme.fg('error', truncate(first, width))];
    }

    const action = text(table.action);
    const quiet =
        tool === 'slack_reply' ||
        tool === 'slack_send_file' ||
        tool === 'slack_done' ||
        (tool === 'slack_manage_message' && action !== 'permalink' && action !== 'reactions') ||
        (tool === 'slack_schedule' && action !== 'list');
    if (quiet) return [];

    if (expanded) return lines.map((line) => theme.fg('toolOutput', line));

    // collapsed, one line. a conversation says the most in its last line, the
    // message that arrived most recently. a listing says it in the entries
    // themselves: "2 people" is a number where the names would fit.
    if (tool === 'slack_read') return [theme.fg('toolOutput', truncate(lines[lines.length - 1] ?? '', width))];
    const listed = lines.slice(1).filter((line) => line.startsWith('  '));
    if (listed.length > 0) return [series(listed.map(label), width, theme)];
    return [theme.fg('toolOutput', truncate(first.endsWith(':') ? first.slice(0, -1) : first, width))];
}
