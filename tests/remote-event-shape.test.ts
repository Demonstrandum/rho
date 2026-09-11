import { describe, expect, test } from 'bun:test';
import { StreamingMessage, reshape } from '../extensions/lib/remote/event-shape';

/**
 * pi's json protocol sends the delta and drops the message so far, because a
 * cumulative snapshot per token is a lot of wire for a consumer that logs. The
 * interface is not that consumer: it redraws the whole assistant message on
 * every update, and without the snapshot it draws nothing at all.
 */

const update = (inner: Record<string, unknown>) =>
    reshape({ type: 'message_update', assistantMessageEvent: inner }, streaming) as unknown as {
        message: { content: { type: string; text?: string }[] };
    };

let streaming = new StreamingMessage();

describe('rebuilding the assistant message', () => {
    test('text arrives as deltas and accumulates', () => {
        streaming = new StreamingMessage();
        reshape({ type: 'message_start', message: { role: 'assistant', content: [] } as never }, streaming);
        update({ type: 'text_start', contentIndex: 0 });
        expect(update({ type: 'text_delta', contentIndex: 0, delta: 'bo' }).message.content[0]?.text).toBe('bo');
        expect(update({ type: 'text_delta', contentIndex: 0, delta: 'nes' }).message.content[0]?.text).toBe('bones');
    });

    test('thinking is kept apart from text', () => {
        streaming = new StreamingMessage();
        update({ type: 'thinking_start', contentIndex: 0 });
        update({ type: 'thinking_delta', contentIndex: 0, delta: 'hm' });
        update({ type: 'text_start', contentIndex: 1 });
        const shaped = update({ type: 'text_delta', contentIndex: 1, delta: 'hello' });
        expect(shaped.message.content.map((part) => part.type)).toEqual(['thinking', 'text']);
        expect(shaped.message.content[1]?.text).toBe('hello');
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
        reshape(
            { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } as never },
            streaming,
        );
        expect((streaming.message as unknown as { content: { text: string }[] }).content[0]?.text).toBe('final');
    });

    test('events that carry no message pass through untouched', () => {
        streaming = new StreamingMessage();
        const event = { type: 'agent_settled' };
        expect(reshape(event, streaming)).toBe(event);
    });
});
