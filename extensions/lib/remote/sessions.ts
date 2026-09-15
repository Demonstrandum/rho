// What a session name refers to, wherever the session is.
//
// A session that outlives its interface is reached by name, and there are two
// kinds: one behind a socket on this machine (/detach), and one behind a socket
// on another (/remote create). Each kind kept its own record -- a directory of
// sockets and a file of transcripts here, a ledger of name-to-host there -- and
// each was read by the extension that wrote it. So `pi --attach overnight`
// resolved the name against this machine alone and reported "no session called
// overnight here" for a session that was running on robotics-vm, which is the
// session most worth coming back to.
//
// The records stay where they are. What moves here is reading them: one
// question, "where is this name", answered from both. detach.ts writes the
// local side and remote.ts writes the ledger, as before.
//
// Connecting is the other half. The remote path is not a spawn: it asks the
// host whether the session is running, creates it when it is not, updates the
// runner, and checks whether the host's rho is older than this machine's. That
// lives in remote.ts and is published here, the way the ui relay is published,
// because the two extensions cannot import each other.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

// Read when asked rather than when loaded, and from the environment first, so
// a test can point HOME at a directory of its own instead of writing into the
// one being used. os.homedir() is the passwd entry and does not follow HOME.
const home = (): string => process.env.HOME ?? homedir();

/** Sockets of the sessions this machine is holding. */
const sockets = (): string => join(home(), '.cache', 'rho', 'sessions');

/** Transcripts a name refers to here once its socket has gone. */
const kept = (): string => join(home(), '.local', 'state', 'rho', 'sessions');

/** Which machine each session started from here is on. */
const ledger = (): string => join(home(), '.cache', 'rho', 'remote', 'sessions.json');

/** What a name on this machine refers to, when nothing is running under it. */
export interface Kept {
    readonly file: string;
    readonly cwd: string;
}

const keptFile = (name: string): string => join(kept(), name, 'local.json');

export function remember(name: string, kept: Kept): void {
    mkdirSync(dirname(keptFile(name)), { recursive: true });
    writeFileSync(keptFile(name), `${JSON.stringify({ version: 1, ...kept }, null, 2)}\n`);
}

export function recall(name: string): Kept | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(keptFile(name), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return null;
        const held = parsed as Partial<Kept>;
        if (typeof held.file !== 'string' || typeof held.cwd !== 'string') return null;
        return { file: held.file, cwd: held.cwd };
    } catch {
        return null;
    }
}

/** Names this machine has a transcript for, running or not. */
export const keptHere = (): string[] => {
    try {
        return readdirSync(kept()).filter((name) => recall(name) !== null);
    } catch {
        return [];
    }
};

/** The sessions this machine is holding, named as they can be typed. */
export const runningHere = (): string[] => {
    try {
        return readdirSync(sockets())
            .filter((file) => file.endsWith('.sock'))
            .map((file) => file.slice(0, -'.sock'.length));
    } catch {
        // No directory means none have ever run here, which is not a fault.
        return [];
    }
};

/** A project's worktree, so connecting to it starts the session in the right directory. */
export interface Worktree {
    readonly host: string;
    readonly path: string;
}

/** The ledger, as the two maps the caller works in. */
export interface Ledger {
    readonly hosts: Map<string, string>;
    readonly worktrees: Map<string, Worktree>;
}

/** The ledger as it is stored. */
interface StoredLedger {
    readonly sessions: Record<string, string>;
    readonly projects: Record<string, Worktree>;
}

export const readLedger = (): Ledger => {
    const empty: Ledger = { hosts: new Map(), worktrees: new Map() };
    try {
        const parsed: unknown = JSON.parse(readFileSync(ledger(), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;
        const held = parsed as Partial<StoredLedger> & Record<string, unknown>;
        // The first version of this file was a flat name-to-host map; it is
        // read as the sessions it was.
        const sessions = held.sessions ?? (held as Record<string, unknown>);
        const hosts = new Map(
            Object.entries(sessions).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
        );
        const worktrees = new Map(
            Object.entries(held.projects ?? {}).filter(
                (pair): pair is [string, Worktree] =>
                    typeof pair[1] === 'object' &&
                    pair[1] !== null &&
                    typeof (pair[1] as Worktree).host === 'string' &&
                    typeof (pair[1] as Worktree).path === 'string',
            ),
        );
        return { hosts, worktrees };
    } catch {
        return empty;
    }
};

export const writeLedger = (held: Ledger): void => {
    try {
        mkdirSync(dirname(ledger()), { recursive: true });
        const stored: StoredLedger = {
            sessions: Object.fromEntries(held.hosts),
            projects: Object.fromEntries(held.worktrees),
        };
        writeFileSync(ledger(), `${JSON.stringify(stored, null, 2)}\n`);
    } catch {
        // A ledger that cannot be written costs the next process a host name on
        // the command line; it is not worth failing a session for.
    }
};

/** Where a name is, and what is known about it there. */
export type Attachable =
    | { readonly where: 'local'; readonly name: string; readonly running: boolean; readonly kept: Kept | null }
    | { readonly where: 'remote'; readonly name: string; readonly host: string; readonly path: string | null };

/**
 * Which session a typed name means.
 *
 * A socket here wins, because a name that is running on this machine is the one
 * the terminal can draw without a network. The ledger comes next, since a name
 * in it was put there by a session that is still on that host. A transcript
 * kept here is last: it is a session that has stopped, and starting it again is
 * the more expensive reading of the name.
 */
export const attachable = (name: string): Attachable | null => {
    if (runningHere().includes(name)) return { where: 'local', name, running: true, kept: recall(name) };
    const { hosts, worktrees } = readLedger();
    const tree = worktrees.get(name);
    const host = hosts.get(name) ?? tree?.host;
    if (host !== undefined) return { where: 'remote', name, host, path: tree?.path ?? null };
    const transcript = recall(name);
    if (transcript !== null) return { where: 'local', name, running: false, kept: transcript };
    return null;
};

/** A name that can be typed after `--attach`, and where it would go. */
export interface Offer {
    readonly name: string;
    readonly where: 'local' | 'remote';
    /** The host, or what the local name is: running, or a transcript. */
    readonly detail: string;
}

/**
 * Every name this machine can attach by, without asking any host anything.
 *
 * The ledger is what was started from here rather than what is running now, so
 * a name in this list can still turn out to be stopped. Finding that out costs
 * an ssh round trip per host, which is not a price a list of names should pay:
 * connecting starts a stopped session anyway.
 */
export const offers = (): Offer[] => {
    const running = runningHere();
    const { hosts, worktrees } = readLedger();
    const remote = new Map<string, string>([
        ...hosts,
        ...[...worktrees].map(([name, tree]): [string, string] => [name, tree.host]),
    ]);
    const found: Offer[] = [
        ...running.map((name): Offer => ({ name, where: 'local', detail: 'running here' })),
        ...[...remote]
            .filter(([name]) => !running.includes(name))
            .map(([name, host]): Offer => ({ name, where: 'remote', detail: host })),
    ];
    const seen = new Set(found.map((offer) => offer.name));
    return [
        ...found,
        ...keptHere()
            .filter((name) => !seen.has(name))
            .map((name): Offer => ({ name, where: 'local', detail: 'stopped here' })),
    ];
};

/**
 * Connecting to a session on another machine, as remote.ts does it.
 *
 * Structural rather than the function itself, for the same reason the ui relay
 * is: what is published crosses two module instances, and only its shape can be
 * checked on the other side.
 */
export type Connect = (ctx: ExtensionContext, session: string, host?: string) => Promise<void>;

const CONNECT_KEY = '__rho_remote_connect';

export const publishConnect = (connect: Connect): void => {
    (globalThis as Record<string, unknown>)[CONNECT_KEY] = connect;
};

export const publishedConnect = (): Connect | null => {
    const held = (globalThis as Record<string, unknown>)[CONNECT_KEY];
    return typeof held === 'function' ? (held as Connect) : null;
};
