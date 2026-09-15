import { describe, expect, test } from 'bun:test';
import { pack, unpack, OPEN, GONE } from '../extensions/lib/remote/origin-channel';

describe('the frames that carry the interface s machine', () => {
    test('bytes survive the round trip, including the ones json cannot hold', () => {
        const bytes = new Uint8Array([0, 1, 10, 13, 34, 92, 0xff, 0xfe]);
        expect(unpack(pack(bytes))).toEqual(bytes);
    });

    test('a frame with no payload is refused rather than read as empty', () => {
        expect(unpack({})).toBeNull();
        expect(unpack({ payload: 42 })).toBeNull();
    });

    test('the channel is opened and ended by name, so the broker can route it', () => {
        expect(OPEN.type).toBe('rho_origin_open');
        expect(GONE).toBe('rho_origin_gone');
    });
});
