import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
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

describe('the far side, mirrored here', () => {
    test('refresh takes both the state and what has been said', async () => {
        const link = open();
        const state = new RemoteState(link);
        await state.refresh();
        expect(state.state.model?.id).toBe('test-model');
        expect(state.messages).toHaveLength(1);
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
