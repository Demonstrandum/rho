import { describe, expect, test } from 'bun:test';
import { remoteSession } from '../extensions/lib/remote/remote-session';
import type { RemoteActions, RemoteState } from '../extensions/lib/remote/proxy-session';
import type { RpcLink } from '../extensions/lib/remote/rpc-link';

/**
 * Which machine answers.
 *
 * The interface calls one object. Some of what it asks belongs here -- the
 * editor, the theme, the settings -- and some belongs to the machine the agent
 * runs on. Getting that split wrong is silent: escape aborted a local session
 * that was not running while the far side carried on answering, and the abort
 * looked as though it had simply failed.
 */

const build = () => {
    const asked: string[] = [];
    const localCalls: string[] = [];

    const local = {
        sessionId: 'local-id',
        sessionFile: '/local/session.jsonl',
        isStreaming: true,
        messages: [{ role: 'user', content: [] }],
        model: { id: 'local-model' },
        settingsManager: { theme: 'dark' },
        sendUserMessage: () => {
            localCalls.push('sendUserMessage');
        },
        abort: () => {
            localCalls.push('abort');
            return Promise.resolve();
        },
        executeBash: () => {
            localCalls.push('executeBash');
            return Promise.resolve();
        },
        dispose: () => {
            localCalls.push('dispose');
        },
    } as unknown as Record<string, unknown>;

    const refusals: string[] = [];
    const state = {
        forkPoints: [{ entryId: 'e1', text: 'earlier' }],
        refuse: (what: string) => refusals.push(what),
        state: {
            model: { id: 'remote-model', provider: 'anthropic' },
            isStreaming: false,
            sessionId: 'remote-id',
            pendingMessageCount: 2,
        },
        messages: [{ role: 'assistant', content: [] }],
        subscribe: () => () => {},
    } as unknown as RemoteState;

    const note =
        (name: string) =>
        (...args: unknown[]) => {
            asked.push(args.length > 0 ? `${name}(${String(args[0])})` : name);
            return Promise.resolve();
        };

    const actions = {
        prompt: note('prompt'),
        steer: note('steer'),
        followUp: note('follow_up'),
        abort: note('abort'),
        abortBash: note('abort_bash'),
        abortRetry: note('abort_retry'),
        bash: note('bash'),
        compact: note('compact'),
        clearQueue: note('clear_queue'),
        cycleModel: note('cycle_model'),
        cycleThinkingLevel: note('cycle_thinking_level'),
        setModel: (provider: string, id: string) => {
            asked.push(`set_model(${provider}/${id})`);
            return Promise.resolve();
        },
        setThinkingLevel: note('set_thinking_level'),
        setSessionName: note('set_session_name'),
        setSteeringMode: note('set_steering_mode'),
        setFollowUpMode: note('set_follow_up_mode'),
        setAutoCompaction: note('set_auto_compaction'),
        setAutoRetry: note('set_auto_retry'),
        sessionStats: note('get_session_stats'),
        lastAssistantText: note('get_last_assistant_text'),
    } as unknown as RemoteActions;

    let stopped = false;
    const link = {
        stop: () => {
            stopped = true;
        },
    } as unknown as RpcLink;

    const session = remoteSession(local, link, state, actions) as Record<string, unknown>;
    return { session, asked, localCalls, refusals, stopped: () => stopped };
};

describe('which machine answers', () => {
    test('what the session is doing comes from the far side', () => {
        const { session } = build();
        expect(session.isStreaming).toBe(false);
        expect(session.isIdle).toBe(true);
        expect(session.sessionId).toBe('remote-id');
        expect((session.model as unknown as { id: string }).id).toBe('remote-model');
        expect(session.pendingMessageCount).toBe(2);
        expect(session.messages).toHaveLength(1);
        expect((session.messages as unknown as { role: string }[])[0]?.role).toBe('assistant');
    });

    test('what belongs to this terminal stays here', () => {
        const { session } = build();
        expect((session.settingsManager as unknown as { theme: string }).theme).toBe('dark');
    });

    test('nothing this process runs pretends to be busy', () => {
        const { session } = build();
        expect(session.isBashRunning).toBe(false);
        expect(session.isRetrying).toBe(false);
    });

    test('every action goes to the machine the session is on', async () => {
        const { session, asked, localCalls } = build();
        const act = session as unknown as Record<string, (...args: unknown[]) => unknown>;
        await act.prompt?.('hello');
        await act.abort?.();
        await act.executeBash?.('uname -a');
        await act.compact?.();
        act.setThinkingLevel?.('high');
        act.setModel?.({ provider: 'anthropic', id: 'claude' });
        act.setSessionName?.('named');
        await act.cycleModel?.();
        expect(asked).toEqual([
            'prompt(hello)',
            'abort',
            'bash(uname -a)',
            'compact',
            'set_thinking_level(high)',
            'set_model(anthropic/claude)',
            'set_session_name(named)',
            'cycle_model',
        ]);
        // The important half: none of it happened here.
        expect(localCalls).toEqual([]);
    });

    test('leaving closes the link and the local session', () => {
        const { session, localCalls, stopped } = build();
        (session as unknown as { dispose: () => void }).dispose();
        expect(stopped()).toBe(true);
        expect(localCalls).toEqual(['dispose']);
    });
});

describe('a refusal is not a crash', () => {
    test('what cannot be asked returns rather than throwing', async () => {
        // The interface calls some of these from a keystroke handler, and an
        // exception there ends the client: double escape opened the fork
        // selector, asked the session what it could fork from, and died.
        const { session } = build();
        const act = session as unknown as Record<string, () => unknown>;
        for (const name of ['exportToJsonl', 'navigateTree', 'reload']) {
            expect(() => act[name]?.()).not.toThrow();
        }
    });

    test('and the reason is said where a person can read it', () => {
        const { session, refusals } = build();
        (session as unknown as Record<string, () => unknown>).reload?.();
        expect(refusals[0]).toContain('reload');
        expect(refusals[0]).toContain('another machine');
    });

    test('what the far side would fork from is answered at once', () => {
        const { session } = build();
        expect((session as unknown as { getUserMessagesForForking: () => unknown[] }).getUserMessagesForForking()).toEqual([
            { entryId: 'e1', text: 'earlier' },
        ]);
    });
});
