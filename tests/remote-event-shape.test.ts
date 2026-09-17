import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';
import { StreamingMessage, reshape } from '../extensions/lib/remote/event-shape';

/**
 * pi's json protocol sends the delta and drops the message so far, because a
 * cumulative snapshot per token is a lot of wire for a consumer that logs. The
 * interface is not that consumer: it redraws the whole assistant message on
 * every update, and without the snapshot it draws nothing at all.
 */

const update = (inner: Record<string, unknown>): { message: AssistantMessage } => {
    reshape({ type: 'message_update', assistantMessageEvent: inner }, streaming);
    return { message: streaming.message };
};

const assistant = (content: AssistantMessage['content']): AssistantMessage => ({
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
});

const text = (part: AssistantMessage['content'][number] | undefined): string | undefined =>
    part?.type === 'text' ? part.text : undefined;

let streaming = new StreamingMessage();

describe('rebuilding the assistant message', () => {
    test('text arrives as deltas and accumulates', () => {
        streaming = new StreamingMessage();
        reshape({ type: 'message_start', message: assistant([]) }, streaming);
        update({ type: 'text_start', contentIndex: 0 });
        expect(text(update({ type: 'text_delta', contentIndex: 0, delta: 'bo' }).message.content[0])).toBe('bo');
        expect(text(update({ type: 'text_delta', contentIndex: 0, delta: 'nes' }).message.content[0])).toBe('bones');
    });

    test('a user message starting carries a plain string and is not the message being built', () => {
        streaming = new StreamingMessage();
        const user: UserMessage = { role: 'user', content: 'hello there', timestamp: 0 };
        expect(() => reshape({ type: 'message_start', message: user }, streaming)).not.toThrow();
        expect(streaming.message.content).toEqual([]);
    });

    test('the frame of the started message is kept under the parts', () => {
        streaming = new StreamingMessage();
        reshape({ type: 'message_start', message: assistant([]) }, streaming);
        update({ type: 'text_start', contentIndex: 0 });
        const shaped = update({ type: 'text_delta', contentIndex: 0, delta: 'x' });
        expect(shaped.message.model).toBe('claude');
        expect(shaped.message.provider).toBe('anthropic');
    });

    test('thinking is kept apart from text', () => {
        streaming = new StreamingMessage();
        update({ type: 'thinking_start', contentIndex: 0 });
        update({ type: 'thinking_delta', contentIndex: 0, delta: 'hm' });
        update({ type: 'text_start', contentIndex: 1 });
        const shaped = update({ type: 'text_delta', contentIndex: 1, delta: 'hello' });
        expect(shaped.message.content.map((part) => part.type)).toEqual(['thinking', 'text']);
        expect(text(shaped.message.content[1])).toBe('hello');
    });

    test('a tool call is readable before its arguments finish arriving', () => {
        streaming = new StreamingMessage();
        update({ type: 'toolcall_start', contentIndex: 0, id: 't1', toolName: 'bash' });
        // Half an object is not json, and the row shows the call regardless.
        const half = update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"command":"un' });
        expect(half.message.content[0]).toMatchObject({ type: 'toolCall', name: 'bash', id: 't1' });
        const whole = update({ type: 'toolcall_delta', contentIndex: 0, delta: 'ame -a"}' });
        expect((whole.message.content[0] as { arguments?: { command?: string } }).arguments?.command).toBe('uname -a');
    });

    test('a finished message replaces what was being built', () => {
        streaming = new StreamingMessage();
        update({ type: 'text_start', contentIndex: 0 });
        update({ type: 'text_delta', contentIndex: 0, delta: 'partial' });
        reshape({ type: 'message_end', message: assistant([{ type: 'text', text: 'final' }]) }, streaming);
        expect(text(streaming.message.content[0])).toBe('final');
    });

    test('events that carry no message pass through untouched', () => {
        streaming = new StreamingMessage();
        const event = { type: 'agent_settled' };
        expect(reshape(event, streaming)).toBe(event);
    });
});
