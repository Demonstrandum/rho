/**
 * How long a turn has gone without a word from the far side.
 *
 * A model request that gets no answer looks exactly like one that is thinking:
 * the interface has nothing to draw either way. One request to a machine whose
 * keep-alive socket had been dropped by the network took five minutes to time
 * out and retry, and the screen did not move once in that time.
 *
 * The decision of when that silence is worth saying out loud is here, away from
 * the drawing, so it can be checked without a terminal.
 */

/** What the session is doing, as far as this machine can tell. */
export type Quiet =
    | { readonly kind: 'settled' }
    | { readonly kind: 'working'; readonly silentMs: number }
    | { readonly kind: 'silent'; readonly silentMs: number };

/**
 * Silence worth reporting.
 *
 * Long enough that an ordinary first token does not trip it: a model that has
 * not started answering within this is either thinking at length or not coming.
 */
export const SILENCE_MS = 15_000;

export function quiet(streaming: boolean, lastEventAt: number | null, now: number): Quiet {
    if (!streaming || lastEventAt === null) return { kind: 'settled' };
    const silentMs = now - lastEventAt;
    return silentMs >= SILENCE_MS ? { kind: 'silent', silentMs } : { kind: 'working', silentMs };
}

/** `waiting on the model, 45s without a reply` */
export function waitingLine(silentMs: number): string {
    const seconds = Math.floor(silentMs / 1000);
    if (seconds < 120) return `waiting on the model, ${seconds}s without a reply`;
    const minutes = Math.floor(seconds / 60);
    return `waiting on the model, ${minutes}m ${seconds % 60}s without a reply`;
}
