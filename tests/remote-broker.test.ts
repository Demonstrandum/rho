import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Broker, existing, named, request } from '../extensions/lib/remote/broker';

/**
 * The broker is tested with a stand-in for pi rather than pi itself: what
 * matters here is that a session outlives its clients, that two clients see
 * one session, and that a late client is caught up. Whether the thing being
 * held is an agent or an echo loop is beside the point.
 */
const STAND_IN = join(import.meta.dir, 'fixtures', 'echo-agent.ts');

const brokers: Broker[] = [];
afterEach(() => {
    for (const broker of brokers) broker.stop();
    brokers.length = 0;
});

const start = (name: string, extra: readonly string[] = []): Broker => {
    const broker = new Broker(name, 'bun', [STAND_IN, ...extra], mkdtempSync(join(tmpdir(), 'rho-broker-')));
    broker.listen();
    brokers.push(broker);
    return broker;
};

const client = (name: string): Promise<{ send: (text: string) => void; lines: string[]; end: () => void }> =>
    new Promise((settle) => {
        const socket = connect(join(process.env.HOME ?? '/tmp', '.cache', 'rho', 'sessions', `${name}.sock`));
        const lines: string[] = [];
        let held = '';
        socket.on('data', (chunk: Buffer) => {
            held += chunk.toString();
            const parts = held.split('\n');
            held = parts.pop() ?? '';
            for (const part of parts) if (part.trim() !== '') lines.push(part);
        });
        socket.on('connect', () =>
            settle({
                send: (text: string) => socket.write(`${text}\n`),
                lines,
                end: () => socket.destroy(),
            }),
        );
    });

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe('broker', () => {
    test('a client reaches the session it names', async () => {
        start('one');
        await settle(100);
        const attached = await client('one');
        attached.send('{"type":"prompt","message":"hello"}');
        await settle();
        expect(attached.lines.join(' ')).toContain('hello');
        attached.end();
    });

    test('the session survives its client leaving, and a new client sees it', async () => {
        start('two');
        await settle(100);
        const first = await client('two');
        first.send('{"type":"prompt","message":"before"}');
        await settle();
        // The point of the whole design: closing the laptop must not end the
        // session, so a client leaving is not the session leaving.
        first.end();
        await settle();
        expect(await existing('two')).toBe(true);

        const second = await client('two');
        second.send('{"type":"prompt","message":"after"}');
        await settle();
        expect(second.lines.join(' ')).toContain('after');
        second.end();
    });

    test('a late client is caught up on what it missed', async () => {
        start('three');
        await settle(100);
        const first = await client('three');
        first.send('{"type":"prompt","message":"earlier"}');
        await settle();
        first.end();

        const late = await client('three');
        await settle();
        // Redraw: a client that attaches to a session in progress needs the
        // recent stream, or it shows an empty screen for a live conversation.
        expect(late.lines.join(' ')).toContain('earlier');
        late.end();
    });

    test('two clients see the same session, not one each', async () => {
        start('four');
        await settle(100);
        const a = await client('four');
        const b = await client('four');
        a.send('{"type":"prompt","message":"shared"}');
        await settle();
        expect(a.lines.join(' ')).toContain('shared');
        expect(b.lines.join(' ')).toContain('shared');
        a.end();
        b.end();
    });

    test('a name that is running is known, one that never ran is not', async () => {
        start('five');
        await settle(100);
        expect(await existing('five')).toBe(true);
        expect(named()).toContain('five');
        expect(await existing('never-started')).toBe(false);
    });

    test('stopping ends the session and frees the name', async () => {
        const broker = start('six');
        await settle(100);
        expect(await existing('six')).toBe(true);
        broker.stop();
        await settle(400);
        expect(await existing('six')).toBe(false);
    });

    test('what the agent complains about travels as an event, not as raw bytes', async () => {
        // pi writes stack traces to stderr. Pushed into a jsonl stream those
        // are half-lines that look like frames, and a client walks past them
        // without ever showing what went wrong.
        start('complaining', ['--complain']);
        const watcher = await client('complaining');
        await new Promise((resolve) => setTimeout(resolve, 700));
        const complaints = watcher.lines
            .map((line) => JSON.parse(line) as { type: string; text?: string })
            .filter((event) => event.type === 'rho_stderr');
        expect(complaints.map((event) => event.text)).toEqual(['a stack trace', 'over two lines']);
        watcher.end();
    });

    test("what the session asked an interface to draw waits for one, and is not replayed as history", async () => {
        // rpc mode has no terminal: `ctx.ui` on the far side is these frames.
        // A notification sent while nobody was attached used to go into the
        // replay buffer, where a client draws it as something that already
        // happened, which is to say does not draw it at all.
        start('asking', ['--ask-at-start']);
        await settle(300);
        const watcher = await client('asking');
        await settle(400);
        const frames = watcher.lines.map((line) => JSON.parse(line) as { type: string; id?: string; method?: string });
        const bracket = frames.findIndex((frame) => frame.type === 'rho_replay_end');
        const drawn = frames.filter((frame) => frame.type === 'extension_ui_request');
        expect(drawn.map((frame) => frame.method)).toEqual(['notify', 'select']);
        // After the replay bracket, if there was one: these are live.
        for (const frame of drawn) expect(frames.indexOf(frame)).toBeGreaterThan(bracket);
        watcher.end();
    });

    test('a dialog nobody answered is asked again of the next interface', async () => {
        start('parked', ['--ask-at-start']);
        await settle(300);
        const first = await client('parked');
        await settle(300);
        first.end();
        await settle(100);

        const second = await client('parked');
        await settle(300);
        const asked = second.lines
            .map((line) => JSON.parse(line) as { type: string; method?: string })
            .filter((frame) => frame.type === 'extension_ui_request');
        // The notification was shown once, to the client that was there for
        // it; the question is still open, so it is put to whoever is here now.
        expect(asked.map((frame) => frame.method)).toEqual(['select']);
        second.end();
    });

    test('an answer reaches the agent under the id it asked with, once', async () => {
        start('answered', ['--ask-at-start']);
        await settle(300);
        const first = await client('answered');
        const second = await client('answered');
        await settle(300);
        // Tagging this the way a command is tagged would make the agent look up
        // an id it never issued, and the extension behind the dialog would wait
        // for ever.
        first.send(JSON.stringify({ type: 'extension_ui_response', id: 'd1', value: 'one' }));
        await settle(200);
        second.send(JSON.stringify({ type: 'extension_ui_response', id: 'd1', value: 'two' }));
        await settle(300);

        const answers = first.lines
            .map((line) => JSON.parse(line) as { type: string; text?: string })
            .filter((event) => typeof event.text === 'string' && event.text.startsWith('answered'));
        expect(answers).toHaveLength(1);
        expect(answers[0]?.text).toContain('"id":"d1"');
        expect(answers[0]?.text).toContain('"value":"one"');
        first.end();
        second.end();
    });

    test('a broker does not outlive the agent it exists to hold', async () => {
        // Stopping a session killed the agent and left the broker resident,
        // reparented to init, holding a machine's memory for nothing and a
        // stale socket that the next attach would connect to.
        const broker = start('mortal');
        const ended = new Promise<void>((resolve) => {
            broker.onEnded = () => resolve();
        });
        broker.stop();
        await ended;
        expect(broker.state.alive).toBe(false);
        expect(await existing('mortal')).toBe(false);
        expect(named()).not.toContain('mortal');
    });

    test('an answer goes to the client that asked, and an event to everyone', async () => {
        // Every client numbers its commands from one, and the agent has a
        // single stdout. Broadcasting answers let one client resolve its own
        // r1 with another client's r1: asking where the session was returned
        // somebody else's state, one request behind.
        start('crossed');
        const first = await client('crossed');
        const second = await client('crossed');
        first.send(`${JSON.stringify({ type: 'prompt', id: 'r1', message: 'for the first' })}\n`);
        second.send(`${JSON.stringify({ type: 'prompt', id: 'r1', message: 'for the second' })}\n`);
        await new Promise((resolve) => setTimeout(resolve, 700));

        const answers = (lines: string[]) =>
            lines
                .map((line) => JSON.parse(line) as { type: string; id?: string; data?: { message?: string } })
                .filter((event) => event.type === 'response');

        expect(answers(first.lines).map((a) => a.data?.message)).toEqual(['for the first']);
        expect(answers(second.lines).map((a) => a.data?.message)).toEqual(['for the second']);
        // And the id each client gets back is the one it chose.
        expect(answers(first.lines).map((a) => a.id)).toEqual(['r1']);
        first.end();
        second.end();
    });

    test('a session nobody is attached to lets its agent go', async () => {
        // An idle pi holds forty to a hundred and fifty megabytes, and eight of
        // them on a small machine put three quarters of a gigabyte into swap:
        // the next turn then waits for the agent to be read back from disk.
        const broker = start('idle');
        const ended = new Promise<void>((resolve) => {
            broker.onEnded = () => resolve();
        });
        broker.retireAfter(150);
        await ended;
        expect(broker.state.alive).toBe(false);
    }, 10_000);

    test('and one with somebody attached is left alone', async () => {
        const broker = start('busy');
        const watcher = await client('busy');
        broker.retireAfter(150);
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(broker.state.alive).toBe(true);
        watcher.end();
    }, 10_000);
});

/**
 * One question and its answer, for a caller that is not an interface.
 *
 * Carrying a conversation between machines asks a running session what it is
 * and hands it a session file, and both are rpc commands: the machine that is
 * connecting needs the answer to its own question and nothing else that is in
 * flight.
 */
describe('a session sending the interface home', () => {
    test('the frame crosses to whoever is attached, and not to the agent', async () => {
        start('sending');
        await settle(100);
        const watcher = await client('sending');
        await settle(100);
        const asSession = await client('sending');
        asSession.send(JSON.stringify({ type: 'rho_origin_open' }));
        asSession.send(JSON.stringify({ type: 'rho_leave' }));
        await settle();
        const seen = watcher.lines.map((line) => JSON.parse(line) as { type: string });
        expect(seen.filter((event) => event.type === 'rho_leave')).toHaveLength(1);
        // The stand-in echoes anything that reaches the agent, so a leave that
        // had gone to pi's stdin would come back as a message.
        expect(watcher.lines.join(' ')).not.toContain('"text":"{\\"type\\":\\"rho_leave');
        watcher.end();
        asSession.end();
    });
});

describe('asking a session one question', () => {
    test('the answer comes back to whoever asked', async () => {
        start('asked');
        await settle(100);
        const answer = await request('asked', { type: 'get_state' });
        expect(answer.success).toBe(true);
        expect((answer.data as { message?: string }).message).toContain('get_state');
    });

    test('and what the session said while nobody watched is still there for the next interface', async () => {
        start('kept', ['--ask-at-start']);
        await settle(150);
        await request('kept', { type: 'get_state' });
        const watcher = await client('kept');
        await settle(600);
        expect(watcher.lines.join(' ')).toContain('no checkpoints available');
        watcher.end();
    });
});
