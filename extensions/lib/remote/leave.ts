/**
 * A session sending the person back to their own machine.
 *
 * Attaching is done from the laptop, and until now leaving was too: the
 * interface is the thing with a terminal, so it is the thing that stops
 * drawing. But the work that decides the session is finished happens on the
 * far side, and an agent there could ask for nothing at all -- it could only
 * say so and wait for somebody to press ctrl+d.
 *
 * The route is the one that is already there. The session's own socket is
 * where an interface attaches and where the far side opens its origin channel,
 * so a frame written to it is delivered to whoever is attached. The interface
 * leaves the way ctrl+d leaves it: the agent stays behind its socket, and the
 * conversation goes back with the person.
 */

import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { LEAVE, OPEN } from './origin-channel';
import { sessionSocketFor } from './origin';

/**
 * Tell whoever is attached to this session to leave.
 *
 * Declared as an origin rather than as an interface, for the reason every
 * short-lived connection to a session socket is: a plain connection is handed
 * everything the agent said while nobody was attached, and this one cannot
 * draw a word of it.
 */
export function askInterfaceToLeave(session: string, home: string): Promise<void> {
    const path = sessionSocketFor(home, session);
    if (!existsSync(path)) {
        return Promise.reject(new Error(`${session} is not held by a runner here, so no interface is attached to it`));
    }
    return new Promise((settle, fail) => {
        const socket = connect(path);
        socket.on('connect', () => {
            socket.write(`${JSON.stringify(OPEN)}\n`);
            socket.write(`${JSON.stringify(LEAVE)}\n`, () => {
                // The frame is the message; the socket closing is not part of
                // it, and closing before the broker has read the line would
                // lose it.
                setTimeout(() => {
                    socket.destroy();
                    settle();
                }, 100).unref?.();
            });
        });
        socket.on('error', (trouble: Error) => fail(new Error(`${session} did not take the message: ${trouble.message}`)));
    });
}
