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
    let active: string[] = ['bash', 'read', 'write', 'edit'];
    const handlers = new Map<string, Handler>();

    const pi = {
        registerTool: (tool: { name: string }) => {
            registered.push(tool.name);
            if (!active.includes(tool.name)) active.push(tool.name);
        },
        registerCommand: () => {},
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
        get active() {
            return active;
        },
        input: async (text: string) => handlers.get('input')?.({ text, source: 'interactive' }),
    };
};

/** The deactivation runs after the factory returns, as it must. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('the environment tool', () => {
    test('is registered but not active at startup', async () => {
        const h = harness();
        environment(h.pi as never);
        await settle();
        expect(h.registered).toContain('environment');
        expect(h.active).not.toContain('environment');
        // The tools it routes are untouched: those are pi's own, and removing
        // them would leave the session unable to do anything at all.
        expect(h.active).toContain('bash');
    });

    test('arrives when the conversation is about another machine', async () => {
        const h = harness();
        environment(h.pi as never);
        await settle();
        await h.input('connect your environment to that gpu node please');
        expect(h.active).toContain('environment');
    });

    test('arrives when the skill is invoked', async () => {
        const h = harness();
        environment(h.pi as never);
        await settle();
        await h.input('/skill:remote');
        expect(h.active).toContain('environment');
    });

    test('stays away for an unrelated conversation', async () => {
        const h = harness();
        environment(h.pi as never);
        await settle();
        await h.input('fix the failing test in tests/env-block.test.ts');
        expect(h.active).not.toContain('environment');
    });
});

describe('the remote_session tool', () => {
    test('is registered but not active at startup', async () => {
        const h = harness();
        remote(h.pi as never);
        await settle();
        expect(h.registered).toContain('remote_session');
        expect(h.active).not.toContain('remote_session');
    });

    test('arrives when a long-lived session is asked for', async () => {
        const h = harness();
        remote(h.pi as never);
        await settle();
        await h.input('start a remote session on dev-box');
        expect(h.active).toContain('remote_session');
    });
});
