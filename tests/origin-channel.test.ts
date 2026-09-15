import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pack, unpack, OPEN, GONE } from '../extensions/lib/remote/origin-channel';
import { connectOverOriginChannel } from '../extensions/lib/remote/client';

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

describe('opening the channel', () => {
    const servers: Server[] = [];
    afterEach(() => {
        for (const server of servers) server.close();
        servers.length = 0;
    });

    test('says what the connection is before it says anything else', async () => {
        // node flushes writes made before a socket connects in the order they
        // were made, so a declaration deferred to the connect event goes out
        // behind a request the caller makes in the same tick. The broker then
        // has a frame from a connection it cannot classify and sends it to the
        // origins, of which there are none: `pwd` on the interface's machine
        // waited out its whole deadline and reported no answer.
        const path = join(mkdtempSync(join(tmpdir(), 'rho-origin-')), 'session.sock');
        const lines: string[] = [];
        const heard = new Promise<void>((settle) => {
            const server = createServer((socket) => {
                let held = '';
                socket.on('data', (chunk: Buffer) => {
                    held += chunk.toString();
                    const parts = held.split('\n');
                    held = parts.pop() ?? '';
                    for (const part of parts) if (part.trim() !== '') lines.push(part);
                    if (lines.length >= 2) settle();
                });
            });
            servers.push(server);
            server.listen(path);
        });

        const connection = connectOverOriginChannel('origin', path);
        // Asked at once, which is what the executor does: the connection is
        // made and used in the same tick.
        void connection.request({ kind: 'stat', path: '/tmp' }, undefined, 2000);
        await heard;
        connection.close();

        expect(JSON.parse(lines[0] as string)).toEqual(OPEN);
        expect((JSON.parse(lines[1] as string) as { type: string }).type).toBe('rho_origin');
    });
});
