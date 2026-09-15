/**
 * Moving one conversation between two machines.
 *
 * A session file is pi's own format: a header line naming the session and the
 * directory it was started in, then one line per entry. Everything needed to
 * continue a conversation is in it, so carrying the context is copying the
 * file and telling the agent on the other side to open it -- no message
 * translation, no partial history, and compaction and branches survive because
 * they are entries like any other.
 *
 * Two things have to be changed on the way. The header names a directory on
 * the machine that wrote it, which does not exist on the other one, and pi
 * refuses a session whose cwd is gone; so the header is rehomed to the
 * directory the receiving session works in. And the destination may already
 * hold a file of that name from an earlier hop, so a free name is chosen
 * rather than overwriting a file another pi has open.
 *
 * The session id is not changed. It is what says two files hold the same
 * conversation, and that is how connect decides whether a remote session is a
 * continuation of this one or a conversation of its own.
 */

import { existsSync } from 'node:fs';
import { join, parse } from 'node:path';

/** The header of a session file: its first line, and the only one read here. */
interface Header {
    readonly type?: string;
    readonly id?: string;
    readonly cwd?: string;
}

const header = (jsonl: string): Header | null => {
    const first = jsonl.slice(0, Math.max(0, jsonl.indexOf('\n')));
    if (first === '') return null;
    try {
        const parsed: unknown = JSON.parse(first);
        if (typeof parsed !== 'object' || parsed === null) return null;
        return parsed as Header;
    } catch {
        return null;
    }
};

/** The conversation's identity, which survives every copy of it. */
export function sessionIdOf(jsonl: string): string | null {
    const head = header(jsonl);
    return typeof head?.id === 'string' ? head.id : null;
}

/** How many entries the file holds, the header not being one of them. */
export function entryCount(jsonl: string): number {
    return jsonl.split('\n').filter((line) => line.trim() !== '').length - (header(jsonl) === null ? 0 : 1);
}

/**
 * The same conversation, working in a directory that exists on this machine.
 *
 * Only the header's cwd changes: the entries are the conversation and are
 * copied byte for byte.
 */
export function rehomed(jsonl: string, cwd: string): string {
    const head = header(jsonl);
    if (head === null || head.type !== 'session') return jsonl;
    const rest = jsonl.slice(jsonl.indexOf('\n') + 1);
    return `${JSON.stringify({ ...head, cwd })}\n${rest}`;
}

/**
 * A path in `dir` nothing is using, from the name the file arrived with.
 *
 * pi's own import does the same thing, and for the same reason: the file a
 * session is reading must not be written underneath it, and a conversation
 * that has crossed between two machines twice would otherwise land on the name
 * it started with.
 */
export function freePath(dir: string, base: string): string {
    const { name, ext } = parse(base);
    let path = join(dir, base);
    for (let suffix = 1; existsSync(path); suffix += 1) path = join(dir, `${name}-${suffix}${ext}`);
    return path;
}
