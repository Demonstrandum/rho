/**
 * The interface's machine, reached over the connection that already exists.
 *
 * A session on a server draws on a laptop, and some work can only happen on
 * that laptop: symba reads the Tailscale identity of whoever opens the
 * connection, so an allocation made from the server is refused however good its
 * credentials are.
 *
 * The first attempt forwarded a unix socket with ssh. On OpenSSH 10.5 that
 * socket is created root-owned with mode 0600 whatever StreamLocalBindMask
 * says, so the account running the session cannot open it, and a loopback port
 * instead would be reachable by every account on the host.
 *
 * None of that is needed. Prompts already travel from the laptop to the agent
 * and events back, so this is another kind of frame on the same connection: the
 * far side opens a channel on its own session socket, the broker pairs it with
 * whoever is attached, and the executor runs in the client process. The route
 * exists exactly while somebody is attached, which is what a laptop is.
 *
 * Bytes are base64 in a JSON line because the link is line-delimited JSON, and
 * the executor's protocol is binary.
 */

import type { Socket } from 'node:net';

/** What travels: a chunk of the executor's protocol, in one direction. */
export interface OriginFrame {
    readonly type: 'rho_origin';
    readonly payload: string;
}

export const OPEN = { type: 'rho_origin_open' } as const;
export const GONE = 'rho_origin_gone' as const;

export const pack = (bytes: Uint8Array): OriginFrame => ({
    type: 'rho_origin',
    payload: Buffer.from(bytes).toString('base64'),
});

export const unpack = (frame: { payload?: unknown }): Uint8Array | null =>
    typeof frame.payload === 'string' ? new Uint8Array(Buffer.from(frame.payload, 'base64')) : null;

/**
 * Read whole lines from a socket, and hand each parsed message on.
 *
 * Both ends of this channel need it, and a half line that arrives split across
 * two chunks is the usual way a protocol like this breaks under load.
 */
export function readLines(socket: Socket, onMessage: (message: Record<string, unknown>) => void): void {
    let held = '';
    socket.on('data', (chunk: Buffer) => {
        held += chunk.toString();
        const lines = held.split('\n');
        held = lines.pop() ?? '';
        for (const line of lines) {
            if (line.trim() === '') continue;
            try {
                onMessage(JSON.parse(line) as Record<string, unknown>);
            } catch {
                // Not ours, or not whole: the stream carries other traffic and
                // a line we cannot read is not a reason to drop the channel.
            }
        }
    });
}
