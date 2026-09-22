/**
 * The events the far side sends, in the shape the interface reads.
 *
 * pi's json protocol drops one thing on purpose: `message_update` carries the
 * delta, not the message so far, because a cumulative snapshot per token is a
 * great deal of wire for a consumer that only logs. The interface is not that
 * consumer -- it redraws the whole assistant message on every update -- so the
 * snapshot is rebuilt here from the deltas, which is where the information
 * already is.
 *
 * Rebuilding rather than asking: a round trip per token would make the
 * interface slower than the terminal it replaces.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, JsonObject, JsonValue, TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai';
import type { RpcEvent } from './rpc-link';

/** A parsed json document that is an object, which is what a call's arguments are. */
function asJsonObject(value: JsonValue): JsonObject | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

/** A tool call whose arguments are still arriving keeps the json text so far. */
interface ArrivingToolCall extends ToolCall {
    raw?: string;
}

type Part = TextContent | ThinkingContent | ArrivingToolCall;

/** Everything an assistant message carries besides its content. */
type Frame = Omit<AssistantMessage, 'content'>;

/**
 * The frame before any `message_start` has named one: an interface attached
 * mid-turn sees deltas for a message whose start it missed.
 */
const UNNAMED_FRAME: Frame = {
    role: 'assistant',
    api: 'pi-messages',
    provider: '',
    model: '',
    usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'pending',
    timestamp: 0,
};

/**
 * One assistant message, assembled as its pieces arrive.
 *
 * `message_start` fires for every message in the loop, a user message with a
 * plain string for content included. Only an assistant message is streamed,
 * so only one is kept; anything else clears what was being built.
 */
export class StreamingMessage {
    private parts: Part[] = [];
    private frame: Frame = UNNAMED_FRAME;

    reset(message?: AgentMessage): void {
        if (message?.role !== 'assistant') {
            this.frame = UNNAMED_FRAME;
            this.parts = [];
            return;
        }
        const { content, ...frame } = message;
        this.frame = frame;
        this.parts = content.map((part) => ({ ...part }));
    }

    /**
     * Apply one streaming event.
     *
     * The names are pi's: text_start opens a block, text_delta extends it,
     * toolcall_start opens a call whose arguments arrive as deltas.
     */
    apply(event: Record<string, unknown>): void {
        const kind = String(event.type ?? '');
        const index = typeof event.contentIndex === 'number' ? event.contentIndex : this.parts.length;

        switch (kind) {
            case 'text_start':
                this.parts[index] = { type: 'text', text: '' };
                break;
            case 'text_delta': {
                const part = this.parts[index];
                const text = part?.type === 'text' ? part : { type: 'text' as const, text: '' };
                text.text = `${text.text}${String(event.delta ?? '')}`;
                this.parts[index] = text;
                break;
            }
            case 'thinking_start':
                this.parts[index] = { type: 'thinking', thinking: '' };
                break;
            case 'thinking_delta': {
                const part = this.parts[index];
                const thought = part?.type === 'thinking' ? part : { type: 'thinking' as const, thinking: '' };
                thought.thinking = `${thought.thinking}${String(event.delta ?? '')}`;
                this.parts[index] = thought;
                break;
            }
            case 'toolcall_start':
                this.parts[index] = {
                    type: 'toolCall',
                    id: typeof event.id === 'string' ? event.id : '',
                    name: typeof event.toolName === 'string' ? event.toolName : '',
                    arguments: {},
                };
                break;
            case 'toolcall_delta': {
                const part = this.parts[index];
                const call: ArrivingToolCall =
                    part?.type === 'toolCall' ? part : { type: 'toolCall', id: '', name: '', arguments: {} };
                const grown = `${call.raw ?? ''}${String(event.delta ?? '')}`;
                call.raw = grown;
                // The arguments arrive as json text; a half-written object is
                // not parseable, and the row shows what it can until it is.
                try {
                    const parsed = asJsonObject(JSON.parse(grown) as JsonValue);
                    if (parsed !== null) call.arguments = parsed;
                } catch {
                    // still arriving
                }
                this.parts[index] = call;
                break;
            }
        }
    }

    get message(): AssistantMessage {
        return { ...this.frame, content: this.parts };
    }
}

/**
 * Put the snapshot back on the events that lost it.
 *
 * Everything else passes through untouched: the interface reads pi's own
 * events, not a translation of them.
 */
export function reshape(event: RpcEvent, streaming: StreamingMessage): RpcEvent | null {
    switch (event.type) {
        case 'message_start': {
            const message = event.message as AgentMessage | undefined;
            streaming.reset(message);
            return event;
        }
        case 'message_update': {
            const inner = event.assistantMessageEvent as Record<string, unknown> | undefined;
            if (inner !== undefined) streaming.apply(inner);
            return { ...event, message: streaming.message } as RpcEvent;
        }
        case 'message_end': {
            const message = event.message as AgentMessage | undefined;
            if (message !== undefined) streaming.reset(message);
            return event;
        }
        default:
            return event;
    }
}
