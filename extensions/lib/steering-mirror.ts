// a read-only copy of pi's steering queue.
//
// pi keeps queued steering messages inside AgentSession and exposes neither the
// contents nor a way to remove one entry (ExtensionContext offers only
// hasPendingMessages()). send-now.ts needs the text of an entry to deliver it
// early, so it rebuilds the queue from the events it can see:
//
//   input, streamingBehavior 'steer'  -> pi pushed an entry
//   message_start, role user          -> pi removed the entry with that text
//                                        (AgentSession splices by text match)
//   hasPendingMessages() false        -> pi cleared both queues at once
//                                        (escape and alt+up call clearQueue)
//
// those three are every way pi's queue changes, so the copy cannot drift while
// staying non-empty. entries are compared by text because that is the identity
// pi itself uses when it drops a delivered message from the queue.

export class SteeringMirror {
    private entries: string[] = [];

    get size(): number {
        return this.entries.length;
    }

    queued(): readonly string[] {
        return this.entries;
    }

    /** oldest entry, the one pi delivers first. */
    oldest(): string | undefined {
        return this.entries[0];
    }

    /** newest entry, the one queued last. */
    newest(): string | undefined {
        return this.entries[this.entries.length - 1];
    }

    push(text: string): void {
        this.entries.push(text);
    }

    /** drop the entry pi just delivered, matched the way pi matches it. */
    delivered(text: string): void {
        const index = this.entries.indexOf(text);
        if (index !== -1) this.entries.splice(index, 1);
    }

    /**
     * reconcile against pi's own count. pi clears steering and follow-up
     * together, so no pending message at all means the queue is empty
     * whatever this copy holds.
     */
    reconcile(hasPendingMessages: boolean): void {
        if (!hasPendingMessages) this.clear();
    }

    clear(): void {
        this.entries = [];
    }
}
