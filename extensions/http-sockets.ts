// a connection is not reused after the network has had time to forget it.
//
// robotics-vm has a private address and reaches the internet through a NAT
// gateway, which drops the record of an idle flow after a few minutes and then
// answers nothing: packets on that connection go nowhere and no reset comes
// back. undici reuses a kept connection for as long as the server's keep-alive
// hint allows, up to ten minutes, so a session that had been quiet for a while
// sent its next request into a socket the network had already forgotten. pi
// then waited out its response timeout, five minutes by default, before the
// retry that worked: one measured turn ran from 15:59:23 to 16:04:23, prompt to
// answer, with the request sent and no byte ever returned.
//
// the reason a connection lived that long is the server's own keep-alive hint:
// undici honours it up to keepAliveMaxTimeout, ten minutes by default, and
// cloudflare asks for minutes. measured against a server asking for 120s, a
// socket idle for 5s was reused under undici's defaults and retired when the
// ceiling was capped at 3s.
//
// so the ceiling is capped here, well inside any NAT's window, and the
// operating system is told to probe the connections that are held, so one that
// dies while open is noticed by the probe rather than by the next request.
//
// pi installs its own dispatcher at startup and points fetch at the same undici
// as the dispatcher; extensions load after that, so this replaces both, and it
// keeps pi's own response timeouts rather than inventing new ones.

import * as undici from 'undici';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { config } from './lib/config';

/** what pi waits for a response, when it has not been told otherwise. */
const DEFAULT_RESPONSE_MS = 300_000;

export interface SocketRules {
    /** how long a connection may sit unused before it is closed rather than reused. */
    readonly keepAliveMs: number;
    /** the longest a server's own keep-alive hint may extend that. */
    readonly keepAliveCeilingMs: number;
    /** how long to wait for a response before giving up on it. */
    readonly responseMs: number;
    /** how long a held connection may be silent before the system probes it. */
    readonly probeAfterMs: number;
}

export function rulesFrom(settings: { keepAliveMs: number; responseMs: number }): SocketRules {
    return {
        keepAliveMs: settings.keepAliveMs,
        // A server hint cannot push reuse past twice the window we chose; the
        // hint is what let a ten minute old connection look usable.
        keepAliveCeilingMs: settings.keepAliveMs * 2,
        responseMs: settings.responseMs,
        probeAfterMs: Math.max(1_000, Math.floor(settings.keepAliveMs / 2)),
    };
}

export function dispatcherFor(rules: SocketRules): undici.Dispatcher {
    return new undici.EnvHttpProxyAgent({
        keepAliveTimeout: rules.keepAliveMs,
        keepAliveMaxTimeout: rules.keepAliveCeilingMs,
        headersTimeout: rules.responseMs,
        bodyTimeout: rules.responseMs,
        connect: {
            // The system's own liveness check, for a connection that dies
            // while it is being used rather than while it is idle.
            keepAlive: true,
            keepAliveInitialDelay: rules.probeAfterMs,
            autoSelectFamilyAttemptTimeout: 2_000,
        },
    });
}

export default function (_pi: ExtensionAPI) {
    const settings = config.http;
    if (settings.keepAliveMs <= 0) return;

    const rules = rulesFrom({ keepAliveMs: settings.keepAliveMs, responseMs: settings.responseMs || DEFAULT_RESPONSE_MS });
    try {
        undici.setGlobalDispatcher(dispatcherFor(rules));
        // fetch and the dispatcher have to be the same undici, or the setting
        // is made on a copy nothing is using. pi does this for its own.
        (globalThis as unknown as { fetch: unknown }).fetch = undici.fetch;
    } catch {
        // a runtime without undici keeps whatever it already had
    }
}
