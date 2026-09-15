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

const build = (
    options: { keepHere?: string[]; commandsHere?: string[]; commandsThere?: string[]; refusing?: string } = {},
) => {
    const asked: string[] = [];
    const localCalls: string[] = [];
    const said: string[] = [];

    const local = {
        extensionRunner: {
            getRegisteredCommands: () =>
                (options.commandsHere ?? []).map((invocationName) => ({ invocationName })),
        },
        prompt: (text: string) => {
            localCalls.push(`prompt(${text})`);
            return Promise.resolve();
        },
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
    let refreshes = 0;
    const snapshot = {
        model: { id: 'remote-model', provider: 'anthropic' },
        isStreaming: false,
        sessionId: 'remote-id',
        pendingMessageCount: 2,
        thinkingLevel: 'off',
    };
    const state = {
        commandsThere: new Set(options.commandsThere ?? []),
        thinkingLevels: ['off', 'medium', 'high'],
        assume: (change: Record<string, unknown>) => Object.assign(snapshot, change),
        forkPoints: [{ entryId: 'e1', text: 'earlier' }],
        refuse: (what: string) => refusals.push(what),
        state: snapshot,
        messages: [{ role: 'assistant', content: [] }],
        subscribe: () => () => {},
        // Choosing a model reads the far side's state back, because pi tells
        // extensions about a model change with an extension event that does
        // not cross the link.
        refresh: async () => {
            refreshes += 1;
        },
    } as unknown as RemoteState;

    const note =
        (name: string) =>
        (...args: unknown[]) => {
            asked.push(args.length > 0 ? `${name}(${String(args[0])})` : name);
            return Promise.resolve();
        };

    const actions = {
        prompt: (text: string, sending?: { streamingBehavior?: string }) => {
            const how = sending?.streamingBehavior === undefined ? '' : `, ${sending.streamingBehavior}`;
            asked.push(`prompt(${text}${how})`);
            return options.refusing === undefined
                ? Promise.resolve()
                : Promise.reject(new Error(options.refusing));
        },
        steer: note('steer'),
        followUp: note('follow_up'),
        abort: note('abort'),
        abortBash: note('abort_bash'),
        abortRetry: note('abort_retry'),
        // The daemon answers a bash command with pi's own response envelope.
        bash: (command: unknown) => {
            asked.push(`bash(${String(command)})`);
            return Promise.resolve({
                type: 'response',
                command: 'bash',
                success: true,
                data: { output: '/far/side\n', exitCode: 0, cancelled: false, truncated: false },
            });
        },
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

    // What pi does before anything wraps the session: bindCore closes over the
    // session that owns the extension runner, and ctx.model calls the closure.
    const bound = {
        getModel: () => local.model,
        getThinkingLevel: () => local.thinkingLevel,
    };

    const session = remoteSession(local, link, state, actions, {
        say: (message: string) => said.push(message),
        keepHere: new Set(options.keepHere ?? []),
    }) as Record<string, unknown>;
    return { session, local, bound, asked, localCalls, said, refreshed: () => refreshes, refusals, stopped: () => stopped };
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

    test('the session pi bound its extensions to reports the far side s model', () => {
        // ctx.model is not a read of the session the interface holds: pi binds
        // it as a call on the session that owns the extension runner, which is
        // the local one. The footer read that, so it named this machine's
        // model for the whole of a remote session.
        const { session, bound } = build();
        expect((bound.getModel() as { id?: string }).id).toBe('remote-model');
        expect(bound.getThinkingLevel()).toBe('off');
        const act = session as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
        void act.setModel?.({ provider: 'openai', id: 'gpt-9' });
        expect((bound.getModel() as { id?: string }).id).toBe('gpt-9');
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

    test('a shell escape gives back the far side s result, and its output', async () => {
        const { session } = build();
        const act = session as unknown as Record<string, (...args: unknown[]) => unknown>;
        const chunks: string[] = [];
        const result = (await act.executeBash?.('pwd', (chunk: string) => chunks.push(chunk))) as {
            exitCode?: number;
        };
        // The interface reads exitCode off this to complete the block, and
        // draws the body from the chunks: returning undefined failed every
        // shell escape after the command had already run.
        expect(result.exitCode).toBe(0);
        expect(chunks.join('')).toBe('/far/side\n');
    });

    test('choosing a model reads the far side back, so the corner names the new one', async () => {
        const { session, refreshed } = build();
        const act = session as unknown as Record<string, (...args: unknown[]) => unknown>;
        act.setModel?.({ provider: 'anthropic', id: 'claude' });
        await act.cycleModel?.();
        act.setThinkingLevel?.('high');
        await act.cycleThinkingLevel?.();
        // Four changes, four reads: pi announces a model change to extensions
        // with an event that does not cross the link, so the snapshot the
        // footer draws from is stale until it is asked again.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(refreshed()).toBe(4);
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

describe('a command runs on the machine it is about', () => {
    test('a command about this terminal runs here and is not sent', async () => {
        const { session, asked, localCalls } = build({
            commandsHere: ['theme'],
            commandsThere: ['theme'],
            keepHere: ['theme'],
        });
        await (session as unknown as Record<string, (text: string) => Promise<void>>).prompt?.('/theme gruvbox');
        expect(localCalls).toEqual(['prompt(/theme gruvbox)']);
        expect(asked).toEqual([]);
    });

    test('a command about the session goes to the session', async () => {
        const { session, asked, localCalls } = build({
            commandsHere: ['rewind', 'theme'],
            commandsThere: ['rewind'],
            keepHere: ['theme'],
        });
        await (session as unknown as Record<string, (text: string) => Promise<void>>).prompt?.('/rewind');
        expect(asked).toEqual(['prompt(/rewind)']);
        expect(localCalls).toEqual([]);
    });

    test('the model the corner names changes as soon as it is chosen', async () => {
        // The footer is drawn from the read that follows setModel, and the far
        // side is a round trip away: the corner went on naming the model
        // before until something else refreshed it.
        const { session } = build();
        const act = session as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
        const chosen = act.setModel?.({ provider: 'openai', id: 'gpt-9' });
        expect((session.model as { id?: string }).id).toBe('gpt-9');
        await chosen;
    });

    test('cycling the thinking level answers at once, because a keystroke cannot wait', () => {
        const { session, asked } = build();
        const act = session as unknown as Record<string, () => unknown>;
        expect(act.cycleThinkingLevel?.()).toBe('medium');
        expect(session.thinkingLevel).toBe('medium');
        expect(asked).toEqual(['set_thinking_level(medium)']);
    });

    test('what the interface says about a turn in progress goes with the message', async () => {
        // pi does not stop you typing while the agent is answering: it calls
        // prompt with a steering behaviour, and a session given none answers
        // `Agent is already processing`, which a local session never does.
        const { session, asked } = build();
        await (session as unknown as Record<string, (text: string, options: unknown) => Promise<void>>).prompt?.(
            'and another thing',
            { streamingBehavior: 'steer' },
        );
        expect(asked).toEqual(['prompt(and another thing, steer)']);
    });

    test('a prompt is a prompt, whatever commands exist', async () => {
        const { session, asked, localCalls } = build({ commandsHere: ['theme'], keepHere: ['theme'] });
        await (session as unknown as Record<string, (text: string) => Promise<void>>).prompt?.('what is here');
        expect(asked).toEqual(['prompt(what is here)']);
        expect(localCalls).toEqual([]);
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

    test('a prompt the far side would not take is said, not swallowed', async () => {
        // The interface reads nothing off these promises, so a rejection was
        // the whole of the feedback and it went nowhere: a prompt refused
        // during compaction left the text gone and the screen unchanged.
        const { session, said } = build({ refusing: 'compaction is in progress' });
        await (session as unknown as Record<string, (text: string) => Promise<void>>).prompt?.('hello');
        expect(said).toHaveLength(1);
        expect(said[0]).toContain('compaction is in progress');
    });

    test('what the far side would fork from is answered at once', () => {
        const { session } = build();
        expect((session as unknown as { getUserMessagesForForking: () => unknown[] }).getUserMessagesForForking()).toEqual([
            { entryId: 'e1', text: 'earlier' },
        ]);
    });
});
