/**
 * Whole turns only, for anything that is told about them.
 *
 * A client can attach in the middle of a turn, and then the first thing it
 * hears is the end of something it never heard begin. Anything that measures a
 * turn measures from nothing: the token rate divided a whole turn's output
 * tokens by its own millisecond floor and reported 63500 tok/s.
 *
 * The interface itself is fine with a half turn, because it draws what it is
 * given. This is only for the extension events, which describe a turn as a
 * span with two ends.
 */

const OPENS = { agent_start: 'agent', turn_start: 'turn' } as const;
const CLOSES = { agent_end: 'agent', turn_end: 'turn' } as const;

type Span = 'agent' | 'turn';

/** Keeps what is open, and says whether an event may be passed on. */
export class TurnGate {
    private readonly open = new Set<Span>();

    /** True when this event belongs to a span this gate has seen begin. */
    admits(type: string): boolean {
        const opening = OPENS[type as keyof typeof OPENS];
        if (opening !== undefined) {
            this.open.add(opening);
            return true;
        }
        const closing = CLOSES[type as keyof typeof CLOSES];
        if (closing === undefined) return true;
        if (!this.open.has(closing)) return false;
        this.open.delete(closing);
        return true;
    }

    /** Which spans are open, for a client that wants to say so. */
    get inside(): readonly Span[] {
        return [...this.open];
    }
}
