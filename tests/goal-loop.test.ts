// the loop itself: what agent_settled does with each verdict, and what the
// four guards do instead of evaluating. the judge is stubbed, so these tests
// pin control flow rather than any model's behaviour.
import { test, expect, mock, beforeEach } from 'bun:test';
import type { Evaluation, Verdict } from '../extensions/lib/model/goal';
import * as real from '../extensions/lib/model/goal';

let queued: Evaluation[] = [];
let calls = 0;

const evaluate = mock(async (): Promise<Evaluation> => {
    calls++;
    const next = queued.shift();
    if (next === undefined) throw new Error('the loop evaluated more times than the test scripted');
    return next;
});

await mock.module('../extensions/lib/model/goal', () => ({ ...real, evaluate }));

const { default: goalExtension } = await import('../extensions/goal');
const { config } = await import('../extensions/lib/core/config');

type Handler = (event: unknown, ctx: unknown) => Promise<void>;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

/** what a test reads off an appended entry: its kind, plus whatever it carries. */
type RecordedEntry = { readonly kind: string } & Record<string, unknown>;

interface Harness {
    readonly settle: () => Promise<void>;
    readonly command: (args: string) => Promise<void>;
    readonly assistantEnded: (stopReason: string, errorMessage?: string) => Promise<void>;
    readonly start: () => Promise<void>;
    readonly sent: string[];
    readonly notified: string[];
    readonly entries: RecordedEntry[];
    /** widget keys currently drawn, so a spinner left running is visible here. */
    readonly widgets: Set<string>;
    pending: boolean;
}

function harness(): Harness {
    const handlers = new Map<string, Handler>();
    let command: CommandHandler | undefined;
    const sent: string[] = [];
    const notified: string[] = [];
    const entries: RecordedEntry[] = [];
    const widgets = new Set<string>();

    const pi = {
        on: (name: string, handler: Handler) => handlers.set(name, handler),
        registerCommand: (_name: string, options: { handler: CommandHandler }) => {
            command = options.handler;
        },
        registerEntryRenderer: () => {},
        appendEntry: (_type: string, data: RecordedEntry) => entries.push(data),
        sendMessage: (message: { content: string }) => sent.push(message.content),
    };
    goalExtension(pi as never);

    const state = { pending: false };
    const ctx = {
        cwd: '/tmp',
        hasUI: true,
        ui: {
            setStatus: () => {},
            notify: (text: string) => notified.push(text),
            setWidget: (key: string, lines: string[] | undefined) => {
                if (lines === undefined) widgets.delete(key);
                else widgets.add(key);
            },
            theme: { fg: (_role: string, text: string) => text },
        },
        // no session id means no state file, so the loop under test writes nothing.
        sessionManager: { getSessionId: () => undefined, getBranch: () => [], buildContextEntries: () => [] },
        hasPendingMessages: () => state.pending,
        model: undefined,
        modelRegistry: { find: () => undefined, complete: async () => ({}) },
        signal: undefined,
    };

    const fire = async (name: string, event: unknown): Promise<void> => {
        const handler = handlers.get(name);
        if (handler === undefined) throw new Error(`no ${name} handler registered`);
        await handler(event, ctx);
    };

    return {
        settle: () => fire('agent_settled', {}),
        command: async (args: string) => {
            if (command === undefined) throw new Error('no /goal command registered');
            await command(args, ctx);
        },
        assistantEnded: (stopReason: string, errorMessage?: string) =>
            fire('message_end', {
                message: {
                    role: 'assistant',
                    stopReason,
                    ...(errorMessage !== undefined && { errorMessage }),
                },
            }),
        start: () => fire('session_start', { reason: 'startup' }),
        sent,
        notified,
        entries,
        widgets,
        get pending() {
            return state.pending;
        },
        set pending(value: boolean) {
            state.pending = value;
        },
    };
}

const verdict = (kind: Verdict['kind'], reason = 'because'): Evaluation => ({
    verdict: kind === 'error' ? { kind, message: reason } : { kind, reason },
    judge: 'test/judge',
    cost: 0,
});

beforeEach(() => {
    queued = [];
    calls = 0;
    evaluate.mockClear();
});

test('a met verdict clears the goal and sends nothing back', async () => {
    const h = harness();
    await h.start();
    await h.command('tests pass');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('"tests pass"');

    queued = [verdict('met', 'npm test exited 0')];
    await h.settle();

    expect(calls).toBe(1);
    expect(h.sent).toHaveLength(1);
    await h.settle();
    expect(calls).toBe(1);
});

test('the spinner is taken down however the check ends', async () => {
    const h = harness();
    await h.start();
    await h.command('tests pass');

    queued = [verdict('unmet', 'still failing'), verdict('error', 'judge did not answer')];
    await h.settle();
    expect(h.widgets.size).toBe(0);
    await h.settle();
    expect(h.widgets.size).toBe(0);
});

test('an unmet verdict restarts the turn with the reason as its input', async () => {
    const h = harness();
    await h.start();
    await h.command('tests pass');

    queued = [verdict('unmet', 'two files still fail')];
    await h.settle();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toContain('two files still fail');
    expect(h.sent[1]).toContain('tests pass');
});

test('an impossible verdict clears the goal', async () => {
    const h = harness();
    await h.start();
    await h.command('read the deleted file');

    queued = [verdict('impossible', 'the file does not exist and cannot be recovered')];
    await h.settle();

    expect(h.sent).toHaveLength(1);
    await h.settle();
    expect(calls).toBe(1);
});

test('an unreadable verdict ends the turn and evaluates again on the next one', async () => {
    const h = harness();
    await h.start();
    await h.command('tests pass');

    queued = [verdict('error', 'judge did not call report_verdict'), verdict('met')];
    await h.settle();
    expect(h.sent).toHaveLength(1);

    await h.settle();
    expect(calls).toBe(2);
});

test('the block cap hands control back with the goal still set', async () => {
    const cap = config.goal.blockCap;
    const h = harness();
    await h.start();
    await h.command('tests pass');

    queued = Array.from({ length: cap + 1 }, () => verdict('unmet', 'still failing'));
    for (let i = 0; i <= cap; i++) await h.settle();

    // the cap counts restarts, so the last verdict pauses instead of sending.
    expect(h.sent).toHaveLength(1 + cap);
    expect(h.notified.some((text) => text.includes('paused'))).toBe(true);

    // the counter reset, so the loop resumes rather than staying stuck.
    queued = [verdict('unmet', 'one left')];
    await h.settle();
    expect(h.sent).toHaveLength(2 + cap);
});

test('an aborted turn pauses the loop without evaluating', async () => {
    const h = harness();
    await h.start();
    await h.command('tests pass');

    await h.assistantEnded('aborted');
    await h.settle();

    expect(calls).toBe(0);
    expect(h.notified.some((text) => text.includes('paused'))).toBe(true);
});

test('a failure a human has to fix clears the goal; a transient one does not', async () => {
    const h = harness();
    await h.start();
    await h.command('tests pass');

    await h.assistantEnded('error', '429 rate limited');
    await h.settle();
    expect(calls).toBe(0);
    expect(h.entries.some((entry) => entry.kind === 'cleared')).toBe(false);

    await h.assistantEnded('error', 'invalid api key');
    await h.settle();
    expect(h.entries.some((entry) => entry.kind === 'cleared')).toBe(true);

    // cleared means cleared: a later settle evaluates nothing.
    await h.assistantEnded('stop');
    await h.settle();
    expect(calls).toBe(0);
});

test('a queued message defers the evaluation to the next settle', async () => {
    const h = harness();
    await h.start();
    await h.command('tests pass');

    h.pending = true;
    await h.settle();
    expect(calls).toBe(0);

    h.pending = false;
    queued = [verdict('met')];
    await h.settle();
    expect(calls).toBe(1);
});

test('/goal clear stops the loop, and the aliases mean the same thing', async () => {
    for (const word of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
        const h = harness();
        await h.start();
        await h.command('tests pass');
        await h.command(word);
        await h.settle();
        expect(calls).toBe(0);
        expect(h.entries.some((entry) => entry.kind === 'cleared')).toBe(true);
    }
});

test('a condition past the character limit is refused', async () => {
    const h = harness();
    await h.start();
    await h.command('x'.repeat(config.goal.maxChars + 1));

    expect(h.sent).toHaveLength(0);
    expect(h.notified.some((text) => text.includes('limited to'))).toBe(true);
});

test('an empty /goal reports status without touching the loop', async () => {
    const h = harness();
    await h.start();
    await h.command('');

    expect(h.entries).toEqual([{ kind: 'status', goal: null, tokens: 0, cost: 0 }]);
    expect(h.sent).toHaveLength(0);
});
