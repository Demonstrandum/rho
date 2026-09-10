import { describe, expect, test } from 'bun:test';
import { Decoder, elide, encode } from '../extensions/lib/remote/protocol';
import type { Frame } from '../extensions/lib/remote/protocol';

const roundTrip = (frame: Frame): Frame[] => new Decoder().push(encode(frame));

describe('framing', () => {
    test('a request survives a round trip', () => {
        const frame: Frame = { type: 'request', id: 7, body: { kind: 'spawn', command: 'echo hi' } };
        expect(roundTrip(frame)).toEqual([frame]);
    });

    test('payload bytes are not text, and are not mangled', () => {
        // The reason for length prefixes rather than JSONL: these bytes are
        // not valid UTF-8 and contain newlines and nulls.
        const data = new Uint8Array([0, 10, 13, 255, 254, 10, 0, 128]);
        const frames = roundTrip({ type: 'event', body: { kind: 'output', process: 'p1', stream: 'stdout', data } });
        const body = frames[0]?.body as { data: Uint8Array };
        expect([...body.data]).toEqual([...data]);
    });

    test('a frame split across chunks is held until it is whole', () => {
        const bytes = encode({ type: 'request', id: 1, body: { kind: 'ping' } });
        const decoder = new Decoder();
        for (let at = 0; at < bytes.byteLength - 1; at++) {
            expect(decoder.push(bytes.subarray(at, at + 1))).toEqual([]);
        }
        const last = decoder.push(bytes.subarray(bytes.byteLength - 1));
        expect(last).toHaveLength(1);
        expect(decoder.pending).toBe(0);
    });

    test('several frames in one chunk all come out, in order', () => {
        const one = encode({ type: 'request', id: 1, body: { kind: 'cwd' } });
        const two = encode({ type: 'request', id: 2, body: { kind: 'ping' } });
        const joined = new Uint8Array(one.byteLength + two.byteLength);
        joined.set(one);
        joined.set(two, one.byteLength);
        const frames = new Decoder().push(joined);
        expect(frames.map((f) => (f.type === 'request' ? f.id : -1))).toEqual([1, 2]);
    });

    test('a chunk boundary inside the payload is not a frame boundary', () => {
        const data = new Uint8Array(5000).fill(65);
        const bytes = encode({ type: 'event', body: { kind: 'output', process: 'p1', stream: 'stdout', data } });
        const decoder = new Decoder();
        expect(decoder.push(bytes.subarray(0, 40))).toEqual([]);
        expect(decoder.push(bytes.subarray(40, 2000))).toEqual([]);
        const frames = decoder.push(bytes.subarray(2000));
        expect(frames).toHaveLength(1);
        expect((frames[0]?.body as { data: Uint8Array }).data.byteLength).toBe(5000);
    });

    test('a corrupt header is reported rather than silently dropped', () => {
        const decoder = new Decoder();
        const bad = new Uint8Array(4 + 3);
        new DataView(bad.buffer).setUint32(0, 3, false);
        bad.set(new TextEncoder().encode('{ns'), 4);
        expect(() => decoder.push(bad)).toThrow(/unreadable frame header/);
    });
});

describe('elide', () => {
    const reference = { process: 'p1', stream: 'stdout' as const };

    test('short output is left alone', () => {
        expect(elide('hello', 100, reference)).toBe('hello');
    });

    test('long output keeps both ends and says what is missing', () => {
        const shown = elide(`START${'x'.repeat(5000)}END`, 200, reference);
        expect(shown.startsWith('START')).toBe(true);
        expect(shown.endsWith('END')).toBe(true);
        // The exact total, not "truncated": an agent that cannot see the
        // number cannot tell whether the rest is worth asking for.
        expect(shown).toContain('5008 total');
        expect(shown).toContain('p1');
    });
});
