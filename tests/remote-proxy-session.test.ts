import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { RpcEvent } from '../extensions/lib/remote/rpc-link';
import { RpcLink } from '../extensions/lib/remote/rpc-link';
import { RemoteActions, RemoteState } from '../extensions/lib/remote/proxy-session';

const DAEMON = join(import.meta.dir, 'fixtures', 'fake-daemon.ts');

const links: RpcLink[] = [];
const open = () => {
    const link = new RpcLink('bun', [DAEMON], { timeoutMs: 5000 });
    links.push(link);
    return link;
};

afterEach(() => {
    while (links.length > 0) links.pop()?.stop();
});

const quiet = async (ms = 250) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};

/** A link with no process behind it, so what the far side is running can be changed mid-test. */
const fakeLink = (model: { id: string; provider: string }) => {
    const asked: string[] = [];
    let running = model;
    let deliver: (event: RpcEvent) => void = () => {};
    const link = {
        onEvent: (listener: (event: RpcEvent) => void) => {
            deliver = listener;
        },
        send: async (command: { type: string }) => {
            asked.push(command.type);
            return command.type === 'get_state' ? { data: { model: running } } : { data: {} };
        },
    } as unknown as RpcLink;
    return {
        link,
        asked,
        nowRunning: (next: { id: string; provider: string }) => {
            running = next;
        },
        fire: (event: Record<string, unknown>) => deliver(event as unknown as RpcEvent),
    };
};

describe('the far side, mirrored here', () => {
    test('refresh takes both the state and what has been said', async () => {
        const link = open();
        const state = new RemoteState(link);
        await state.refresh();
        expect(state.state.model?.id).toBe('test-model');
        expect(state.messages).toHaveLength(1);
    });

    test('what the far side can run is part of what refresh asks', async () => {
        // A slash command typed into the client has to go to the side that
        // owns it, and only the far side knows what it has.
        const link = open();
        const state = new RemoteState(link);
        await state.refresh();
        expect([...state.commandsThere].sort()).toEqual(['rewind', 'theme']);
    });

    test('one refused question does not abandon the rest, and the refusal is kept', async () => {
        const link = open();
        const state = new RemoteState(link);
        await state.refresh();
        // The state and the messages arrived even though the fork points were
        // refused, and the refusal is said to whoever listens afterwards --
        // attaching asks these before the interface exists.
        expect(state.state.model?.id).toBe('test-model');
        const heard: string[] = [];
        state.onRefusal((what) => heard.push(what));
        expect(heard.join(' ')).toContain('nothing to fork from');
    });

    test('a turn moves the streaming flag and appends what was said', async () => {
        const link = open();
        const state = new RemoteState(link);
        const seen: string[] = [];
        state.subscribe((event) => seen.push(event.type));
        await new RemoteActions(link).prompt('hello');
        await quiet();
        expect(seen).toContain('agent_start');
        expect(seen).toContain('agent_settled');
        expect(state.state.isStreaming).toBe(false);
        expect(state.messages).toHaveLength(1);
    });

    test('history is kept but not announced as news', async () => {
        // A client that treats the replay buffer as live answers the question
        // before it -- which is exactly what happened before the brackets.
        const link = open();
        const state = new RemoteState(link);
        const seen: string[] = [];
        state.subscribe((event) => seen.push(event.type));
        await link.send({ type: 'replay' });
        await quiet();
        expect(state.messages).toHaveLength(1);
        expect(seen).not.toContain('message_end');
    });

    test('live events after a replay are announced again', async () => {
        const link = open();
        const state = new RemoteState(link);
        await link.send({ type: 'replay' });
        await quiet();
        const seen: string[] = [];
        state.subscribe((event) => seen.push(event.type));
        await new RemoteActions(link).prompt('now');
        await quiet();
        expect(seen).toContain('message_end');
    });

    test('every action is a command, and none of them is invented locally', async () => {
        const link = open();
        const sent: string[] = [];
        const spy = {
            send: (command: Record<string, unknown>) => {
                sent.push(String(command.type));
                return Promise.resolve({});
            },
        } as unknown as RpcLink;
        const actions = new RemoteActions(spy);
        await Promise.all([
            actions.prompt('a'),
            actions.steer('b'),
            actions.followUp('c'),
            actions.abort(),
            actions.compact(),
            actions.setModel('anthropic', 'claude'),
            actions.setThinkingLevel('high'),
            actions.clearQueue(),
        ]);
        expect(sent).toEqual([
            'prompt',
            'steer',
            'follow_up',
            'abort',
            'compact',
            'set_model',
            'set_thinking_level',
            'clear_queue',
        ]);
    });

    test('a turn that refuses is not silence', async () => {
        // An empty assistant message reads as the model having nothing to say.
        // The far side's token expiring looked exactly like that.
        const link = open();
        const state = new RemoteState(link);
        expect(state.trouble).toBeNull();
        await link.send({ type: 'refuse' });
        await quiet();
        expect(state.trouble).toBe('the token expired');
    });

    test('a refusal in the history is not reported as current trouble', async () => {
        const link = open();
        const state = new RemoteState(link);
        await link.send({ type: 'old_refusal' });
        await quiet();
        expect(state.trouble).toBeNull();
    });

    test('a model chosen on the far side reaches the corner', async () => {
        // pi raises model_select on its extensions and not on its session
        // subscribers, so the choice never crosses the link: a session told
        // to change model by anything other than this interface went on being
        // named by the model it was attached on.
        const wire = fakeLink({ id: 'first', provider: 'anthropic' });
        const state = new RemoteState(wire.link);
        await state.syncState();
        expect(state.state.model?.id).toBe('first');

        wire.nowRunning({ id: 'second', provider: 'openai' });
        wire.fire({
            type: 'message_end',
            message: { role: 'assistant', provider: 'openai', model: 'second', content: [] },
        });
        await quiet(20);
        expect(state.state.model?.id).toBe('second');
        expect(state.state.model?.provider).toBe('openai');
    });

    test('the state is asked for again when a turn starts', async () => {
        const wire = fakeLink({ id: 'first', provider: 'anthropic' });
        const state = new RemoteState(wire.link);
        wire.nowRunning({ id: 'third', provider: 'anthropic' });
        wire.fire({ type: 'agent_start' });
        await quiet(20);
        expect(wire.asked).toContain('get_state');
        expect(state.state.model?.id).toBe('third');
    });

    test('a turn answered by the model already named asks nothing', async () => {
        const wire = fakeLink({ id: 'first', provider: 'anthropic' });
        const state = new RemoteState(wire.link);
        await state.syncState();
        wire.asked.length = 0;
        wire.fire({
            type: 'message_end',
            message: { role: 'assistant', provider: 'anthropic', model: 'first', content: [] },
        });
        await quiet(20);
        expect(wire.asked).toEqual([]);
    });

    test('a listener can leave without stopping the mirror', async () => {
        const link = open();
        const state = new RemoteState(link);
        let count = 0;
        const off = state.subscribe(() => {
            count += 1;
        });
        off();
        await new RemoteActions(link).prompt('hello');
        await quiet();
        expect(count).toBe(0);
        expect(state.messages).toHaveLength(1);
    });
});
