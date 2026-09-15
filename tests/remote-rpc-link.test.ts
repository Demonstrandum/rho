import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { RpcLink } from '../extensions/lib/remote/rpc-link';
import type { LinkOptions, RpcEvent } from '../extensions/lib/remote/rpc-link';

const DAEMON = join(import.meta.dir, 'fixtures', 'fake-daemon.ts');

const links: RpcLink[] = [];
const open = (options: LinkOptions = {}) => {
    const link = new RpcLink('bun', [DAEMON], options);
    links.push(link);
    return link;
};

afterEach(() => {
    while (links.length > 0) links.pop()?.stop();
});

const settled = (link: RpcLink, type: string) =>
    new Promise<RpcEvent>((resolve) => {
        const off = link.onEvent((event) => {
            if (event.type === type) {
                off();
                resolve(event);
            }
        });
    });

describe('the link to a daemon', () => {
    test('answers are matched to their own command', async () => {
        const link = open();
        // Both in flight at once: an answer that arrives for the wrong caller
        // is the failure this guards.
        const [state, messages] = await Promise.all([
            link.send({ type: 'get_state' }),
            link.send({ type: 'get_messages' }),
        ]);
        expect((state.data as { model: { id: string } }).model.id).toBe('test-model');
        expect((messages.data as { messages: unknown[] }).messages).toHaveLength(1);
    });

    test('a line is a line only at \\n, so U+2028 in a string survives', async () => {
        const link = open();
        const ended = settled(link, 'message_end');
        await link.send({ type: 'prompt', message: 'hello' });
        const event = (await ended) as unknown as { message: { content: { text: string }[] } };
        expect(event.message.content[0]?.text).toBe('a\u2028b');
    });

    test('a command nobody answers fails by its deadline, and says which command', async () => {
        const link = open({ timeoutMs: 200 });
        await expect(link.send({ type: 'slow' })).rejects.toThrow(/slow went unanswered/);
    });

    test('a deadline of zero waits indefinitely', async () => {
        const link = open({ timeoutMs: 0 });
        const raced = await Promise.race([
            link.send({ type: 'slow' }).then(() => 'answered'),
            new Promise((resolve) => setTimeout(() => resolve('still waiting'), 300)),
        ]);
        expect(raced).toBe('still waiting');
    });

    test('the daemon dying fails what was in flight, with what it said on the way out', async () => {
        const link = open({ timeoutMs: 5000 });
        const inFlight = link.send({ type: 'slow' });
        link.tell({ type: 'die' });
        await expect(inFlight).rejects.toThrow(/the daemon fell over/);
        expect(link.closed).toMatch(/the daemon fell over/);
    });

    test('a closed link refuses rather than hanging', async () => {
        const link = open();
        link.stop();
        await expect(link.send({ type: 'get_state' })).rejects.toThrow(/closed from this end/);
    });

    test('lines that are not ours are walked past', async () => {
        // ssh banners, motd, and half-written json all land on this channel;
        // one of them corrupted frames in practice.
        const link = new RpcLink('bun', [DAEMON, '--noise'], { timeoutMs: 5000 });
        links.push(link);
        const seen: string[] = [];
        link.onEvent((event) => seen.push(event.type));
        const state = await link.send({ type: 'get_state' });
        expect(state.type).toBe('response');
        expect(seen).toEqual([]);
    });

    test('listeners can be dropped', async () => {
        const link = open();
        let count = 0;
        const off = link.onEvent(() => {
            count += 1;
        });
        await link.send({ type: 'prompt', message: 'one' });
        await settled(link, 'agent_settled');
        const afterFirst = count;
        off();
        await link.send({ type: 'prompt', message: 'two' });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(afterFirst).toBeGreaterThan(0);
        expect(count).toBe(afterFirst);
        // Two prompts, two daemon starts and a deliberate wait: alone this is
        // under a second, but run beside fifty other files it has exceeded the
        // default five-second budget on a loaded machine, which reads as a
        // broken listener rather than a busy one.
    }, 20_000);
});
