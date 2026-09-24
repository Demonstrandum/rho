// the provider payloads this session has sent, newest last, bounded.
//
// pi hands `before_provider_request` the serialized payload and nothing else,
// so what a request was aimed at (the model, the time) is recorded beside it
// here. the payload is `unknown` because its shape is the provider's: anthropic
// sends { system, messages, tools }, openai sends { messages }, and an
// extension may have rewritten either before the hook ran.
//
// the bound is a capacity, not a check at each call site: a session sends one
// payload per turn per retry, and each carries the whole conversation, so an
// unbounded log is a copy of the transcript per turn held in memory.

export interface CapturedRequest {
    /** 1-based, in capture order, and never reused after an entry is dropped. */
    readonly ordinal: number;
    readonly at: number;
    /** provider/id at the time of the request, or null when no model was set. */
    readonly model: string | null;
    readonly payload: unknown;
}

export class RequestLog {
    private readonly entries: CapturedRequest[] = [];
    private next = 1;

    constructor(private readonly capacity: number) {}

    record(payload: unknown, model: string | null, at: number = Date.now()): CapturedRequest {
        const entry: CapturedRequest = { ordinal: this.next, at, model, payload };
        this.next += 1;
        this.entries.push(entry);
        while (this.entries.length > this.capacity) this.entries.shift();
        return entry;
    }

    /** oldest first. */
    list(): readonly CapturedRequest[] {
        return this.entries;
    }

    get size(): number {
        return this.entries.length;
    }

    latest(): CapturedRequest | undefined {
        return this.entries[this.entries.length - 1];
    }

    byOrdinal(ordinal: number): CapturedRequest | undefined {
        return this.entries.find((entry) => entry.ordinal === ordinal);
    }

    clear(): number {
        const dropped = this.entries.length;
        this.entries.length = 0;
        return dropped;
    }
}
