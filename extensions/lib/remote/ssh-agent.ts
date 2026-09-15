/**
 * Whether there is an agent to forward, asked before it is forwarded.
 *
 * `ssh -A` with no agent is not an error: ssh forwards nothing, the far side
 * gets no socket, and the clone fails as GitHub refusing a key that was never
 * offered. The message a person sees is "Permission denied (publickey)", which
 * sends them to look at their GitHub account, their deploy keys and the far
 * side's authorized_keys, none of which is the problem.
 *
 * pi is the usual reason the agent is missing: a session started from a launch
 * agent, a cron job or a desktop launcher inherits no SSH_AUTH_SOCK even when
 * the person's terminal has one.
 */

import { spawnSync } from 'node:child_process';

/** Why a clone on another machine would fail, or null when it would not. */
export type AgentTrouble =
    | { readonly kind: 'no-agent' }
    | { readonly kind: 'no-keys' }
    | { readonly kind: 'unreachable'; readonly said: string };

/**
 * `where` is the environment to ask about, defaulting to this process's.
 *
 * An environment rather than a socket string, because a default parameter
 * cannot tell "no socket" from "not given": passing undefined to mean "there
 * is no agent" silently asked about this process's own, which is how the first
 * version of this reported a machine with no agent as fine.
 */
export function agentTrouble(where: Record<string, string | undefined> = process.env): AgentTrouble | null {
    const socket = where.SSH_AUTH_SOCK;
    if (socket === undefined || socket === '') return { kind: 'no-agent' };
    // The socket is passed in the environment, because that is the only way
    // ssh-add takes one: asking about a socket while it reads a different one
    // from the environment answers about the wrong agent.
    const asked = spawnSync('ssh-add', ['-l'], {
        encoding: 'utf8',
        timeout: 5_000,
        env: { ...process.env, SSH_AUTH_SOCK: socket },
    });
    // ssh-add exits 1 for an agent holding nothing and 2 for an agent it could
    // not reach, which are different problems with different fixes.
    if (asked.status === 0) return null;
    if (asked.status === 1) return { kind: 'no-keys' };
    return { kind: 'unreachable', said: (asked.stderr ?? '').trim() || `ssh-add exited ${asked.status}` };
}

/** What to tell somebody, in the place where the clone was about to happen. */
export function describeAgentTrouble(trouble: AgentTrouble, what = 'a private repository'): string {
    const start = 'eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519';
    switch (trouble.kind) {
        case 'no-agent':
            return (
                `no ssh agent on this machine, so nothing can be forwarded and ${what} cannot be cloned. ` +
                `GitHub would report this as "Permission denied (publickey)". Start one with: ${start}` +
                ' (a session started from a launch agent or a desktop launcher inherits no SSH_AUTH_SOCK).'
            );
        case 'no-keys':
            return `the ssh agent is running but holds no keys, so ${what} cannot be cloned. Add one with: ssh-add ~/.ssh/id_ed25519`;
        case 'unreachable':
            return `SSH_AUTH_SOCK is set but the agent does not answer (${trouble.said}), so ${what} cannot be cloned. Start one with: ${start}`;
    }
}
