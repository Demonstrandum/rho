/**
 * Telling the agent where it now is, when something moved it.
 *
 * The `<env>` and `<git>` blocks are built once, before the first turn, and
 * they describe where the session started. `/cwd`, a project checkout, and a
 * handover to a session on another machine all move the ground under the agent
 * after that, and none of them said so: the move was a `ui.notify`, which is
 * drawn for the person and is not in the conversation at all. The agent then
 * reasoned about the old directory, on the old machine, with the old branch.
 *
 * So a move sends the same facts the prompt opened with, as a message: where it
 * is, and what the work tree there looks like. The git read runs where the tree
 * is, which is not this machine when an environment is attached.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { config } from '../core/config';
import { render as renderGit, renderFailure, snapshot, type GitRunner } from './git-snapshot';
import type { Captured } from '../remote/client';

/** What moved the agent. The wording of the note is the only difference. */
export type Move = 'cwd' | 'project' | 'environment';

const BECAUSE: Record<Move, string> = {
    cwd: 'the working directory changed',
    project: 'a project checkout changed the working directory',
    environment: 'the machine the tools act on changed',
};

/** Where the agent stands now: one machine, one directory. */
export interface Place {
    /** the machine the tools act on, or null when that is this one. */
    readonly host: string | null;
    readonly cwd: string;
    /** how git is asked about this tree; omitted means this machine's git. */
    readonly git?: GitRunner;
}

/** Single quotes, because a path may hold anything a shell would read. */
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * git on the far side, as a runner the snapshot can use.
 *
 * `git -C` rather than a `cd`, so the directory is git's argument and not a
 * shell statement that a failure would leave half-executed.
 */
export const gitThrough =
    (capture: (command: string, timeoutMs?: number) => Promise<Captured>): GitRunner =>
    async (args, cwd, timeoutMs) => {
        const said = await capture(`git -C ${quote(cwd)} ${args.map(quote).join(' ')}`, timeoutMs);
        if (said.code === 0) return { ok: true, text: said.stdout };
        if (said.code === null) {
            return { ok: false, code: null, errors: said.stderr === '' ? 'git did not run' : said.stderr, timedOut: false };
        }
        return { ok: false, code: said.code, errors: said.stderr, timedOut: false };
    };

/** The block sent to the agent, and the line drawn for the person. */
export interface Note {
    readonly content: string;
    readonly host: string | null;
    readonly cwd: string;
    readonly branch: string | null;
}

/** The `<git>` block for a work tree, wherever it is, and the branch in it. */
export async function gitBlockFor(place: Place): Promise<{ readonly text: string | null; readonly branch: string | null }> {
    if (!config.git.snapshot) return { text: null, branch: null };
    const reading = await snapshot({
        cwd: place.cwd,
        commits: config.git.commits,
        maxFiles: config.git.maxFiles,
        timeoutMs: config.git.timeoutMs,
        ...(place.git === undefined ? {} : { run: place.git }),
    });
    if (reading.kind === 'snapshot') return { text: renderGit(reading.state), branch: reading.state.branch };
    return { text: renderFailure(reading.failure), branch: null };
}

export async function whereNote(move: Move, place: Place): Promise<Note> {
    const lines = ['<location>', `${BECAUSE[move]}, so this is where the tools act now`];
    if (place.host !== null) lines.push(`host: ${place.host}`);
    lines.push(`cwd: ${place.cwd}`);
    lines.push('this replaces the cwd in the <env> block, which describes where the session started.');
    lines.push('</location>');

    const git = await gitBlockFor(place);
    if (git.text !== null) lines.push('', git.text);

    return { content: lines.join('\n'), host: place.host, cwd: place.cwd, branch: git.branch };
}

/** What the renderer is given, so the screen shows a line and the model the block. */
export interface LocationDetails {
    readonly host: string | null;
    readonly cwd: string;
    readonly branch: string | null;
}

export const LOCATION_MESSAGE = 'location';

/**
 * One line on screen, the block underneath for the model.
 *
 * Registered by each sender rather than by one owner: the map is keyed by the
 * message type and the registration is the same function, so the last one to
 * load wins and wins identically.
 */
export function registerLocationRenderer(pi: ExtensionAPI): void {
    pi.registerMessageRenderer(LOCATION_MESSAGE, (message, options, theme) => {
        const details = message.details as LocationDetails | undefined;
        const parts = [theme.fg('accent', 'location')];
        if (details?.host != null) parts.push(theme.fg('text', details.host));
        parts.push(theme.fg('dim', details?.cwd ?? ''));
        if (details?.branch != null) parts.push(theme.fg('dim', details.branch));
        const line = parts.join('  ');
        const content = typeof message.content === 'string' ? message.content : '';
        return new Text(options.expanded ? `${line}\n${theme.fg('dim', content)}` : line, options.outputPad, 0);
    });
}

/** Send the note into the conversation, after whatever is already queued. */
export async function announceWhere(pi: ExtensionAPI, move: Move, place: Place): Promise<Note> {
    const note = await whereNote(move, place);
    pi.sendMessage(
        {
            customType: LOCATION_MESSAGE,
            content: note.content,
            display: true,
            details: { host: note.host, cwd: note.cwd, branch: note.branch } satisfies LocationDetails,
        },
        { deliverAs: 'followUp' },
    );
    return note;
}
