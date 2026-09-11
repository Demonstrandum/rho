import { describe, expect, test } from 'bun:test';
import environment from '../extensions/environment';
import remote from '../extensions/remote';

/**
 * A tool definition is paid for on every request of every session, so these
 * two stay out of the prompt until something asks for them. The skill is what
 * tells the model they exist.
 */

interface Handler {
    (event: { text: string; source?: string }): Promise<unknown>;
}

const harness = () => {
    const registered: string[] = [];
    const descriptions: string[] = [];
    let active: string[] = ['bash', 'read', 'write', 'edit'];
    const handlers = new Map<string, Handler>();

    const pi = {
        registerTool: (tool: { name: string; description?: string }) => {
            registered.push(tool.name);
            if (typeof tool.description === 'string') descriptions.push(tool.description);
            if (!active.includes(tool.name)) active.push(tool.name);
        },
        registerCommand: () => {},
        registerMessageRenderer: () => {},
        getActiveTools: () => [...active],
        setActiveTools: (names: string[]) => {
            active = [...names];
        },
        on: (event: string, handler: Handler) => {
            handlers.set(event, handler);
        },
        sendMessage: () => {},
    };

    return {
        pi,
        registered,
        descriptions,
        get active() {
            return active;
        },
        input: async (text: string) => handlers.get('input')?.({ text, source: 'interactive' }),
        /**
         * The first turn, which is when the tools are taken out of the active
         * set. It cannot happen at load: pi refuses action methods while
         * extensions are loading, and a timer there kills the session.
         */
        turn: async () => handlers.get('before_agent_start')?.({ text: '' }),
    };
};

describe('the environment tool', () => {
    test('is registered but not active at startup', async () => {
        const h = harness();
        environment(h.pi as never);
        await h.turn();
        expect(h.registered).toContain('environment');
        expect(h.active).not.toContain('environment');
        // The tools it routes are untouched: those are pi's own, and removing
        // them would leave the session unable to do anything at all.
        expect(h.active).toContain('bash');
    });

    test('arrives when the conversation is about another machine', async () => {
        const h = harness();
        environment(h.pi as never);
        await h.turn();
        await h.input('connect your environment to that gpu node please');
        expect(h.active).toContain('environment');
    });

    test('arrives when the skill is invoked', async () => {
        const h = harness();
        environment(h.pi as never);
        await h.turn();
        await h.input('/skill:remote');
        expect(h.active).toContain('environment');
    });

    test('stays away for an unrelated conversation', async () => {
        const h = harness();
        environment(h.pi as never);
        await h.turn();
        await h.input('fix the failing test in tests/env-block.test.ts');
        expect(h.active).not.toContain('environment');
    });
});

describe('the routed file tools', () => {
    test('say in their description how to address another machine', async () => {
        // The only place the model looks before choosing an argument: a syntax
        // documented nowhere it reads is a syntax nobody uses.
        const h = harness();
        environment(h.pi as never);
        await h.turn();
        const described = h.descriptions.filter((text) => text.includes('user@host:/abs/path'));
        expect(described.length).toBeGreaterThanOrEqual(3);
        expect(described.every((text) => text.includes('local:/abs/path'))).toBe(true);
    });
});

describe('the remote_session tool', () => {
    test('is registered but not active at startup', async () => {
        const h = harness();
        remote(h.pi as never);
        await h.turn();
        expect(h.registered).toContain('remote_session');
        expect(h.active).not.toContain('remote_session');
    });

    test('arrives when a long-lived session is asked for', async () => {
        const h = harness();
        remote(h.pi as never);
        await h.turn();
        await h.input('start a remote session on robotics-vm');
        expect(h.active).toContain('remote_session');
    });
});
