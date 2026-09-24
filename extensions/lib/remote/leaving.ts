/**
 * What happens to a conversation when its interface is closed.
 *
 * Closing the interface onto a session on another machine used to mean one
 * thing: the session stayed up, and everything said on it came back into the
 * local session. That is the common case and a poor only case. Somebody who
 * connected to look at a long run wants the local transcript left as it was,
 * and somebody who is finished for the day wants the shell.
 *
 * So the interface asks, and the answer travels to the process that acts on
 * it. The menu is drawn by the client, which is showing the far side; the
 * carrying is done by the interface that launched it, which is the only one
 * holding a local session to carry into. One line on stderr joins the two:
 * the launcher already captures that stream to report why a client stopped.
 */

import type { Option } from '../tui/choice';

/** The three ways out, named by what happens to the conversation on screen. */
export type Leaving = 'carry' | 'leave' | 'exit';

/** The marker the client writes and the launcher reads. */
const MARKER = 'rho-leave:';

/**
 * What the launcher tells the client about the conversation it handed over.
 *
 * The menu is drawn on the far side of a spawn from the session that would
 * receive a carried conversation, so whether carrying is possible at all is
 * something only the launcher knows.
 */
const CARRY = 'RHO_CARRY_BACK';

/** Whether this interface is showing a conversation the launcher also holds. */
export const carryingBack = (): boolean => process.env[CARRY] === '1';

/** The environment a client is launched with, saying the same thing. */
export const carryEnv = (joined: boolean): Record<string, string> => ({ [CARRY]: joined ? '1' : '0' });

const ORDER: readonly Leaving[] = ['carry', 'leave', 'exit'];

const isLeaving = (word: string): word is Leaving => (ORDER as readonly string[]).includes(word);

/**
 * The menu, for a session called `name` on `host`.
 *
 * `carry` is offered only when the two sides hold one conversation. A session
 * with a history of its own was never joined to this one, so there is nothing
 * to bring back and the option would do nothing.
 */
export function leavingOptions(joined: boolean): readonly Option<Leaving>[] {
    const all: readonly Option<Leaving>[] = [
        { id: 'carry', tag: 'carry', label: 'take this conversation back to the local session' },
        { id: 'leave', tag: 'leave', label: 'leave it here, back to the local session as it was' },
        { id: 'exit', tag: 'exit', label: 'leave it here, out to the shell' },
    ];
    return joined ? all : all.filter((option) => option.id !== 'carry');
}

/** The question above the menu: what does not change, whichever is picked. */
export function leavingTitle(name: string, host: string | undefined): string {
    const where = host === undefined || host === '' || host === 'local' ? '' : ` on ${host}`;
    return `${name}${where} keeps running either way.`;
}

/** A choice given as a word rather than picked from the menu: /detach carry. */
export function leavingNamed(word: string): Leaving | null {
    const cleaned = word.trim().toLowerCase();
    return isLeaving(cleaned) ? cleaned : null;
}

/** Say what was picked, to whoever launched this interface. */
export function sayLeaving(choice: Leaving): void {
    process.stderr.write(`${MARKER} ${choice}\n`);
}

/**
 * What the client picked, from everything it wrote to stderr.
 *
 * The last marker wins, since a client that reconnected within one run would
 * have written an earlier one. Nothing found means an interface that closed
 * without being asked, which is what an older client does and what the far
 * side's own `rho_leave` does: both mean the conversation comes home.
 */
export function leavingIn(stderr: string): Leaving | null {
    const said = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(MARKER))
        .map((line) => leavingNamed(line.slice(MARKER.length)))
        .filter((choice): choice is Leaving => choice !== null);
    return said[said.length - 1] ?? null;
}

/** Everything but the marker, so a reason for stopping still reads as one. */
export function withoutLeaving(stderr: string): string {
    return stderr
        .split('\n')
        .filter((line) => !line.trim().startsWith(MARKER))
        .join('\n');
}
