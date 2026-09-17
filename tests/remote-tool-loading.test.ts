import { describe, expect, test } from 'bun:test';
import environment from '../extensions/environment';
import remote from '../extensions/remote';

/**
 * A tool definition is paid for on every request of every session, so these
 * two stay out of the prompt until something asks for them. The skill is what
 * tells the model they exist.
 */

interface Handler {
    (event: { text: string; source?: string }, ctx?: unknown): Promise<unknown>;
}

const harness = () => {
    const registered: string[] = [];
    const descriptions: string[] = [];
    const sent: string[] = [];
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
        sendMessage: (message: { content?: string }) => {
            sent.push(typeof message.content === 'string' ? message.content : '');
        },
    };

    return {
        pi,
        registered,
        descriptions,
        sent,
        /** A resume, with no UI, as a headless session has. */
        resume: async (cwd: string, sessionId: string) =>
            handlers.get('session_start')?.({ text: '' } as never, {
                cwd,
                hasUI: false,
                sessionManager: { getSessionId: () => sessionId },
            }),
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

describe('resuming a session that was working elsewhere', () => {
    test('says so, rather than carrying on as though nothing moved', async () => {
        const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const envPaths = (await import('env-paths')).default;

        // Written where the store actually looks, because the store resolves
        // that path once at load and an environment variable set here is too
        // late to change it.
        const dir = join(envPaths('rho', { suffix: '' }).data, 'state', 'session');
        const id = '01a09999-0000-0000-0000-000000000000';
        const file = join(dir, `${id}.environment.json`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            file,
            JSON.stringify({ version: 1, host: 'samuel@dev-box', name: 'dev-box', cwd: '/home/samuel' }),
        );

        try {
            const h = harness();
            environment(h.pi as never);
            await h.resume(process.cwd(), id);

            // Without a UI it cannot ask, so it states the change: a session
            // whose history is full of another machine must not read as though
            // it is still there.
            const said = h.sent.join('\n');
            expect(said).toContain('samuel@dev-box');
            expect(said).toContain('working locally');
        } finally {
            rmSync(file, { force: true });
        }
    });
});

describe('the remote_session tool', () => {
    /**
     * Which machine the test is pretending to be.
     *
     * A session held by a runner keeps these tools whatever the conversation
     * says, and the broker says so through RHO_SESSION_NAME. The test process
     * inherits that variable when the suite is run from inside a session that
     * is itself held by one, and the startup case then failed for being right:
     * the tools were active because the agent was, by construction, a remote
     * session.
     */
    const asLocal = <T>(run: () => Promise<T>): Promise<T> => {
        const held = process.env.RHO_SESSION_NAME;
        delete process.env.RHO_SESSION_NAME;
        return run().finally(() => {
            if (held !== undefined) process.env.RHO_SESSION_NAME = held;
        });
    };

    test('is registered but not active at startup, on a machine holding its own session', async () =>
        asLocal(async () => {
            const h = harness();
            remote(h.pi as never);
            await h.turn();
            expect(h.registered).toContain('remote_session');
            expect(h.active).not.toContain('remote_session');
        }));

    test('is active from the start in a session a runner holds, which is one by construction', async () => {
        const held = process.env.RHO_SESSION_NAME;
        process.env.RHO_SESSION_NAME = 'held-by-a-runner';
        try {
            const h = harness();
            remote(h.pi as never);
            await h.turn();
            expect(h.active).toContain('remote_session');
        } finally {
            if (held === undefined) delete process.env.RHO_SESSION_NAME;
            else process.env.RHO_SESSION_NAME = held;
        }
    });

    test('arrives when a long-lived session is asked for', async () =>
        asLocal(async () => {
            const h = harness();
            remote(h.pi as never);
            await h.turn();
            await h.input('start a remote session on dev-box');
            expect(h.active).toContain('remote_session');
        }));
});
