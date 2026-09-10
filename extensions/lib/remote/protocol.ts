/**
 * The wire between a session and something that holds work for it.
 *
 * Two things speak it: an executor on a rented node, which owns processes and
 * files, and a broker on the always-on host, which owns a running session. They
 * are the same shape -- a long-lived process on the far side, a client that
 * comes and goes, and output that must not all cross the wire at once -- so the
 * framing, the request/response pairing and the range reads are written once
 * here and neither side reimplements them.
 *
 * Framing is a length prefix, not JSONL, because command output is arbitrary
 * bytes: a newline-delimited protocol has to escape or base64 every payload,
 * which is a third more bytes for output that is mostly large and mostly never
 * read in full. A frame is
 *
 *     <header length: uint32 BE> <header JSON> <payload>
 *
 * where the header names the payload's length. Payloads stay bytes all the way
 * through; only the header is text.
 */

/** A request the client sends. Every one carries an id; every one is answered. */
export type Request =
    | { readonly kind: 'ping' }
    /** Start a process. Output is kept on the far side and read by range. */
    | {
          readonly kind: 'spawn';
          readonly command: string;
          /** Absent means the environment's current directory. */
          readonly cwd?: string;
          readonly env?: Readonly<Record<string, string>>;
          /** Kill the process after this long, in milliseconds. */
          readonly timeout?: number;
      }
    /** Feed stdin to a running process. */
    | { readonly kind: 'stdin'; readonly process: ProcessId; readonly data: Uint8Array }
    | { readonly kind: 'signal'; readonly process: ProcessId; readonly signal: 'TERM' | 'KILL' | 'INT' }
    /**
     * Read part of a stream a process produced. The whole point of keeping
     * output on the far side: a 40 MB build log costs a head and a tail unless
     * something asks for the rest.
     */
    | {
          readonly kind: 'read-range';
          readonly process: ProcessId;
          readonly stream: 'stdout' | 'stderr';
          readonly offset: number;
          readonly length: number;
      }
    /** Forget a finished process and its output. */
    | { readonly kind: 'release'; readonly process: ProcessId }
    | { readonly kind: 'read-file'; readonly path: string; readonly offset?: number; readonly length?: number }
    | { readonly kind: 'write-file'; readonly path: string; readonly data: Uint8Array; readonly mode?: number }
    /**
     * Exact-match replacement, done on the far side.
     *
     * Not a shell pipeline: an edit that has to match exact text including
     * whitespace cannot survive being quoted through sed, and doing it here
     * means the file is read and written once rather than shipped twice.
     */
    | {
          readonly kind: 'edit-file';
          readonly path: string;
          readonly edits: readonly { readonly old: string; readonly new: string }[];
      }
    | { readonly kind: 'stat'; readonly path: string }
    | { readonly kind: 'list'; readonly path: string; readonly glob?: string }
    /** Where relative paths resolve from, for this connection. */
    | { readonly kind: 'chdir'; readonly path: string }
    | { readonly kind: 'cwd' };

/** What the far side sends back. Replies carry the id of their request. */
export type Reply =
    | { readonly kind: 'pong'; readonly version: number; readonly host: string; readonly cwd: string }
    | { readonly kind: 'spawned'; readonly process: ProcessId }
    | { readonly kind: 'bytes'; readonly data: Uint8Array; readonly eof: boolean }
    | { readonly kind: 'stat'; readonly exists: boolean; readonly directory: boolean; readonly bytes: number; readonly mode: number }
    | { readonly kind: 'names'; readonly names: readonly string[] }
    | { readonly kind: 'cwd'; readonly path: string }
    | { readonly kind: 'ok' }
    | { readonly kind: 'error'; readonly message: string; readonly code?: string };

/** Sent without being asked for: output as it is produced, so a slow command is not silent. */
export type Event =
    | { readonly kind: 'output'; readonly process: ProcessId; readonly stream: 'stdout' | 'stderr'; readonly data: Uint8Array }
    /**
     * A process finished. Nobody asked, so it is an event and not a reply.
     * The byte counts are the whole of what it produced, not what was sent:
     * the client decides how much of that it wants to see.
     */
    | {
          readonly kind: 'exited';
          readonly process: ProcessId;
          readonly code: number | null;
          readonly signal: string | null;
          readonly stdoutBytes: number;
          readonly stderrBytes: number;
      }
    /** The far side is going away: pre-empted, killed, disconnected. */
    | { readonly kind: 'gone'; readonly why: string };

export type ProcessId = string;

export const PROTOCOL_VERSION = 1;

/** A frame is one of these three, and the id pairs a reply with its request. */
export type Frame =
    | { readonly type: 'request'; readonly id: number; readonly body: Request }
    | { readonly type: 'reply'; readonly id: number; readonly body: Reply }
    | { readonly type: 'event'; readonly body: Event };

const EMPTY = new Uint8Array(0);

/** The payload travels beside the header rather than inside it, so bytes stay bytes. */
const payloadOf = (frame: Frame): Uint8Array => {
    const body = frame.body as { data?: Uint8Array };
    return body.data instanceof Uint8Array ? body.data : EMPTY;
};

const withoutPayload = (frame: Frame): unknown => {
    const body = frame.body as Record<string, unknown>;
    if (!(body.data instanceof Uint8Array)) return frame;
    const { data: _omitted, ...rest } = body;
    return { ...frame, body: rest };
};

export function encode(frame: Frame): Uint8Array {
    const payload = payloadOf(frame);
    const header = new TextEncoder().encode(
        JSON.stringify({ ...(withoutPayload(frame) as object), bytes: payload.byteLength }),
    );
    const out = new Uint8Array(4 + header.byteLength + payload.byteLength);
    new DataView(out.buffer).setUint32(0, header.byteLength, false);
    out.set(header, 4);
    out.set(payload, 4 + header.byteLength);
    return out;
}

/**
 * Frames out of a byte stream that arrives in arbitrary pieces.
 *
 * A stream splits wherever the network felt like it, so a decoder that assumes
 * whole frames works locally and corrupts everything over ssh. This keeps the
 * remainder and yields only what is complete.
 */
export class Decoder {
    private buffer = new Uint8Array(0);

    push(chunk: Uint8Array): Frame[] {
        const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
        joined.set(this.buffer);
        joined.set(chunk, this.buffer.byteLength);
        this.buffer = joined;

        const frames: Frame[] = [];
        for (;;) {
            if (this.buffer.byteLength < 4) break;
            const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
            const headerLength = view.getUint32(0, false);
            if (this.buffer.byteLength < 4 + headerLength) break;

            const headerBytes = this.buffer.subarray(4, 4 + headerLength);
            let header: { bytes?: number; type?: string; id?: number; body?: Record<string, unknown> };
            try {
                header = JSON.parse(new TextDecoder().decode(headerBytes)) as typeof header;
            } catch (error) {
                throw new Error(`unreadable frame header: ${(error as Error).message}`);
            }
            const payloadLength = header.bytes ?? 0;
            if (this.buffer.byteLength < 4 + headerLength + payloadLength) break;

            const payload = this.buffer.slice(4 + headerLength, 4 + headerLength + payloadLength);
            this.buffer = this.buffer.slice(4 + headerLength + payloadLength);

            const { bytes: _count, ...frame } = header as Record<string, unknown>;
            const body = (frame.body ?? {}) as Record<string, unknown>;
            frames.push(
                (payloadLength > 0
                    ? { ...frame, body: { ...body, data: payload } }
                    : frame) as unknown as Frame,
            );
        }
        return frames;
    }

    /** What is held back waiting for the rest of a frame. Zero between frames. */
    get pending(): number {
        return this.buffer.byteLength;
    }
}

/**
 * A head and a tail of a large output, with the middle named rather than sent.
 *
 * This is the shape the agent sees by default: enough to know what happened,
 * an exact byte count, and a way to ask for the rest. Truncating without
 * saying so is how an agent reads half a log and concludes the wrong thing.
 */
export function elide(
    text: string,
    limit: number,
    reference: { readonly process: ProcessId; readonly stream: 'stdout' | 'stderr' },
): string {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= limit) return text;
    const half = Math.floor(limit / 2);
    const decoder = new TextDecoder();
    const head = decoder.decode(bytes.subarray(0, half));
    const tail = decoder.decode(bytes.subarray(bytes.byteLength - half));
    const hidden = bytes.byteLength - 2 * half;
    return [
        head,
        `\n[... ${hidden} bytes not shown. ${bytes.byteLength} total in ${reference.stream} of ${reference.process}.`,
        `Ask for a range to see them. ...]\n`,
        tail,
    ].join('');
}
