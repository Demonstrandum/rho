/**
 * The ssh control socket is keyed by the agent as well as the host.
 *
 * A shared master is reused for every later connection, and a session opened
 * through it inherits the agent forwarding of the connection that made it. An
 * agent that has since been restarted leaves the master forwarding a socket
 * nobody answers: commands on the far side then see SSH_AUTH_SOCK set and
 * `ssh-add -l` reply "communication with agent failed", and a clone fails about
 * public keys while a fresh connection works.
 *
 * Naming the control path after the agent as well means a different agent is a
 * different master, which is what it already is in every way that matters.
 */

import { createHash } from 'node:crypto';

export function agentTag(socket: string | undefined = process.env.SSH_AUTH_SOCK): string {
    if (socket === undefined || socket === '') return 'noagent';
    return createHash('sha256').update(socket).digest('hex').slice(0, 8);
}

/** `<dir>/cm-%C-<agent>`, for ssh's own ControlPath expansion. */
export function controlPath(dir: string, socket?: string): string {
    return `${dir}/cm-%C-${agentTag(socket)}`;
}
