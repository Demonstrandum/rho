import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Broker, existing, named } from '../extensions/lib/remote/broker';

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
});
