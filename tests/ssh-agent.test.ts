import { describe, expect, test } from 'bun:test';
import { agentTrouble, describeAgentTrouble } from '../extensions/lib/remote/ssh-agent';

describe('whether there is an agent to forward', () => {
    test('an environment with no socket is no agent, not this process s own', () => {
        // The first version took a socket string with a default, so passing
        // undefined to mean "none" asked about this process instead and
        // reported a machine with no agent as fine.
        expect(agentTrouble({})).toEqual({ kind: 'no-agent' });
        expect(agentTrouble({ SSH_AUTH_SOCK: '' })).toEqual({ kind: 'no-agent' });
    });

    test('a socket that nothing is listening on is reported as unreachable', () => {
        const trouble = agentTrouble({ SSH_AUTH_SOCK: '/tmp/rho-test-not-an-agent.sock' });
        expect(trouble?.kind).toBe('unreachable');
    });
});

describe('what it tells somebody', () => {
    test('the missing-agent message names the failure they will actually see', () => {
        const said = describeAgentTrouble({ kind: 'no-agent' }, 'rho on dev-box');
        expect(said).toContain('rho on dev-box');
        expect(said).toContain('Permission denied (publickey)');
        expect(said).toContain('ssh-add');
    });

    test('an agent holding nothing is a different instruction from having none', () => {
        const empty = describeAgentTrouble({ kind: 'no-keys' });
        expect(empty).toContain('holds no keys');
        expect(empty).not.toContain('ssh-agent -s');
    });

    test('an unreachable agent quotes what ssh-add said', () => {
        const said = describeAgentTrouble({ kind: 'unreachable', said: 'Error connecting to agent' });
        expect(said).toContain('Error connecting to agent');
    });
});
