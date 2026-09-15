/**
 * The machine the interface is running on, reachable from the session.
 *
 * A session on a server can reach anywhere it has credentials for, and the one
 * machine it cannot reach is usually the laptop in front of the person: the
 * laptop has no fixed address, is often behind something, and is only awake
 * when somebody is using it. Some work has to happen there anyway. nodes is the
 * case that forced this: Cloud trusts the Tailscale identity of whoever opens
 * the connection, there is no credential to copy, and a tagged server has no
 * user identity, so an allocation has to be made from the laptop itself.
 *
 * ssh carries a unix socket in either direction, so when the interface attaches
 * it forwards one back: the executor listens here, the socket appears over
 * there, and the session can run a command on this machine for as long as the
 * interface is attached. When the interface leaves, the socket goes, which is
 * the truth about a laptop rather than a limitation.
 */

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { dirname, join } from 'node:path';
import { serve } from './executor';

/** What the far side calls this machine, and what `on` accepts for it. */
export const ORIGIN = 'origin' as const;

/**
 * Where the forwarded socket appears on the machine holding the session.
 *
 * In the account's own directory, and that is a permission decision rather
 * than a tidiness one. sshd creates a forwarded socket as root with mode 0600,
 * which the account the session runs as cannot connect to (EACCES), so the
 * socket has to be made group and world writable for the session to use it at
 * all. A writable socket under /tmp would give every account on the machine a
 * shell on the laptop; under a home directory the enclosing directory is the
 * thing that refuses them.
 */
export const originSocketFor = (home: string, session: string): string =>
    join(home, '.cache', 'rho', 'sessions', `${session}.origin.sock`);

/** Where the executor listens on the machine drawing the session. */
export const originListenPath = (home: string, session: string): string =>
    join(home, '.cache', 'rho', 'remote', `origin-${session}.sock`);

/**
 * Listen, one executor per connection.
 *
 * Per connection rather than one shared: the executor holds a working
 * directory and a process table, and two callers sharing those would move each
 * other's shell out from under them.
 */
export function listenAsOrigin(path: string): Server {
    mkdirSync(dirname(path), { recursive: true });
    // A socket file left by a process that died is not a listener, and binding
    // over it fails with EADDRINUSE while nothing is actually there.
    if (existsSync(path)) unlinkSync(path);
    const server = createServer((socket) => {
        serve(socket, socket);
        socket.on('error', () => socket.destroy());
    });
    server.listen(path);
    return server;
}

/**
 * The ssh arguments that carry it.
 *
 * StreamLocalBindUnlink clears the file a previous attach left behind, which
 * otherwise refuses the bind while nothing is listening on it. The mask is the
 * inverse of the permission bits, so 0111 gives a socket of 0666: the account
 * running the session can connect to a socket sshd made as root, and the home
 * directory it sits in is what keeps everyone else out.
 */
export const forwardArgs = (remotePath: string, localPath: string): readonly string[] => [
    '-o',
    'StreamLocalBindUnlink=yes',
    '-o',
    'StreamLocalBindMask=0111',
    '-R',
    `${remotePath}:${localPath}`,
];
