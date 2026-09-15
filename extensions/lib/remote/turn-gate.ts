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

/**
 * The events that only mean anything inside a turn.
 *
 * Holding back the ends alone is not enough for a client that attached in the
 * middle of one. An extension that starts on the first thing it hears and
 * stops on the end of the turn then starts and never stops: the wait line said
 * `waiting on the model, 29s without a reply` under a turn that had finished
 * and an answer that was already on screen. So a turn joined in progress is
 * passed on in neither direction, and the next whole turn is the one
 * extensions are told about.
 */
const SPAN_SCOPED: ReadonlySet<string> = new Set([
    'agent_start',
    'turn_start',
    'message_start',
    'message_update',
    'message_end',
    'tool_execution_start',
    'tool_execution_update',
    'tool_execution_end',
    'turn_end',
    'agent_end',
    'agent_settled',
]);

type Span = 'agent' | 'turn';

/** Keeps what is open, and says whether an event may be passed on. */
export class TurnGate {
    private readonly open = new Set<Span>();
    private joined = false;

    /**
     * Said by a client that attached while the far side was already answering.
     *
     * The spans it walked in on are held open, because their ends are still
     * coming: an agent run that is part way through a tool call will raise
     * `turn_start` for the turn after it, and everything from there on is a
     * span this client has seen begin. Without the inherited `agent` span that
     * run's `agent_end` is dropped, and an extension that started on the new
     * turn never hears it stop -- the wait line counted for the rest of the
     * session under an answer already on screen.
     */
    join(): void {
        this.joined = true;
        this.open.add('agent');
        this.open.add('turn');
    }

    /** Whether this gate is inside a turn it did not see begin. */
    get joinedMidTurn(): boolean {
        return this.joined;
    }

    /** True when this event belongs to a span this gate has seen begin. */
    admits(type: string): boolean {
        const opening = OPENS[type as keyof typeof OPENS];
        if (opening !== undefined) {
            // A turn that begins is a turn this gate has seen whole, whatever
            // it walked in on.
            this.joined = false;
            this.open.add(opening);
            return true;
        }
        const closing = CLOSES[type as keyof typeof CLOSES];
        if (this.joined) {
            // The end of the turn this client walked in on: not passed on,
            // since its beginning was not, but the span is closed all the same
            // so the next one is measured from where it starts.
            if (closing !== undefined) this.open.delete(closing);
            return !SPAN_SCOPED.has(type);
        }
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
