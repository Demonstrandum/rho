// which machine a tool argument names, and the absolute path on it.
//
// a path in a tool call means a file on whatever machine the tools are acting
// on, unless it carries an address of its own: environment.ts gives read,
// write and edit the `user@host:/path` and `local:/path` forms, so anything
// inspecting those calls has to resolve the same way or it inspects the wrong
// file.
//
// the environment is passed in rather than imported, so this stays testable
// without a connection.

import { isAbsolute, resolve } from 'node:path';
import { parseLocated, sshTarget } from './remote/address';
import { localStore, remoteStore, type FileStore, type Said } from './file-store';

/** the parts of an attached environment a path needs to resolve against. */
export interface Attached {
    readonly name: string;
    readonly host: string;
    readonly cwd: string;
    readonly alive: boolean;
    capture(command: string, timeoutMs?: number): Promise<Said>;
}

export type Target =
    | { readonly kind: 'here'; readonly store: FileStore; readonly path: string }
    /**
     * an addressed path on a machine this session has no connection to. the
     * guard and the journal both leave it alone: there is no way to read what
     * is there without opening a connection of their own, and a wrong answer
     * about a file is worse than no answer.
     */
    | { readonly kind: 'elsewhere'; readonly address: string };

/** some models write the path with an @ in front; pi's own tools strip it. */
const unprefixed = (path: string): string => (path.startsWith('@') ? path.slice(1) : path);

export function targetFor(
    raw: string,
    localCwd: string,
    environment: Attached | undefined,
): Target {
    const located = parseLocated(unprefixed(raw));
    const live = environment !== undefined && environment.alive ? environment : undefined;
    const here = (store: FileStore, base: string): Target => ({
        kind: 'here',
        store,
        path: isAbsolute(located.path) ? located.path : resolve(base, located.path),
    });
    switch (located.where.kind) {
        case 'local':
            return here(localStore(), localCwd);
        case 'current':
            return live === undefined
                ? here(localStore(), localCwd)
                : here(remoteStore(live.name, (command, timeoutMs) => live.capture(command, timeoutMs)), live.cwd);
        case 'remote': {
            const address = sshTarget(located.where.address);
            if (live !== undefined && live.host === address) {
                return here(remoteStore(live.name, (command, timeoutMs) => live.capture(command, timeoutMs)), live.cwd);
            }
            return { kind: 'elsewhere', address };
        }
    }
}
