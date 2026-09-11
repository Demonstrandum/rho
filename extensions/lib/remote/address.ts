/**
 * Where work happens, as a value rather than a string to be re-split.
 *
 * The same text appears in four places -- an `/environment` argument, a
 * `bash` `on`, an addressed path, and the name a connection is filed under --
 * and every one of them was taking the string apart again with `split('@')`
 * and `indexOf(':')`. Four parsers disagree eventually: the one that produced
 * a directory from `user@host:/srv` was not the one that produced a name from
 * `user@host`, so a colon in the wrong place meant a host called `/srv`.
 *
 * One parser, one record, and the places that need a string ask for it.
 */

/** A machine, and optionally a directory on it. `null` user means the local account's. */
export interface Address {
    readonly user: string | null;
    readonly host: string;
    readonly path: string | null;
}

/** This machine, named rather than implied. */
export const LOCAL = 'local' as const;

/** What a path or a command can be pointed at. */
export type Where =
    /** the machine this session runs on */
    | { readonly kind: 'local' }
    /** a named machine, with an optional directory */
    | { readonly kind: 'remote'; readonly address: Address }
    /** whatever the session is currently pointing at */
    | { readonly kind: 'current' };

const USER = '[A-Za-z0-9._-]+';
const HOST = '[A-Za-z0-9._-]+';

/** `user@host`, `host`, either with an optional `:/absolute/path`. */
const ADDRESS = new RegExp(`^(?:(${USER})@)?(${HOST})(?::(\\/[^\\0]*))?$`);

/**
 * An address, or `null` when the text is not one.
 *
 * Deliberately strict about two things. A path must be absolute, because a
 * relative one means a different file depending on where the far side happens
 * to be. And a bare word is a host, not a user, so `dev-box` and
 * `samuel@dev-box` both work and neither is guessed at.
 */
export function parseAddress(text: string): Address | null {
    const found = ADDRESS.exec(text.trim());
    if (found === null) return null;
    const [, user, host, path] = found;
    if (host === undefined || host === '') return null;
    return { user: user ?? null, host, path: path ?? null };
}

/** The text ssh wants: `user@host`, or `host` when the user is the caller's. */
export function sshTarget(address: Address): string {
    return address.user === null ? address.host : `${address.user}@${address.host}`;
}

/**
 * What a connection is filed under.
 *
 * The host alone, so `samuel@dev-box` and `ubuntu@dev-box` do not
 * collide with each other in one session but do read as the same machine, and
 * so the name a person types is the name they saw.
 */
export function addressName(address: Address): string {
    return address.host;
}

/** `local:/path`, `user@host:/path`, or a bare path meaning the current machine. */
export interface Located {
    readonly where: Where;
    readonly path: string;
}

/**
 * Two characters at least, in the addressed-path form only.
 *
 * `C:/windows/style` is otherwise a host called `C`, which would send a local
 * file to a machine that does not exist. scp resolves the same ambiguity the
 * same way. A one-character hostname is legal and can still be attached with
 * /environment, where there is no path to be confused with.
 */
const LOCATED_HOST = '[A-Za-z0-9._-]{2,}';

const LOCATED = new RegExp(`^(?:(${LOCAL})|(?:(${USER})@)?(${LOCATED_HOST})):(\\/[^\\0]*)$`);

/**
 * A path with the machine it belongs to, when it names one.
 *
 * A bare path is `current` rather than `local`: while an environment is
 * attached, an unqualified path means that machine, and reading it as this one
 * is how a file gets written to the wrong host.
 */
export function parseLocated(text: string): Located {
    const found = LOCATED.exec(text.trim());
    if (found === null) return { where: { kind: 'current' }, path: text };
    const [, local, user, host, path = ''] = found;
    if (local !== undefined) return { where: { kind: 'local' }, path };
    if (host === undefined) return { where: { kind: 'current' }, path: text };
    return { where: { kind: 'remote', address: { user: user ?? null, host, path: null } }, path };
}

/** How a target is written back to a person: an address, or the word local. */
export function describeWhere(where: Where): string {
    switch (where.kind) {
        case 'local':
            return LOCAL;
        case 'current':
            return 'the current environment';
        case 'remote':
            return sshTarget(where.address);
    }
}
