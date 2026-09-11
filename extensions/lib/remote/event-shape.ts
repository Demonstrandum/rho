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
import type { RpcEvent } from './rpc-link';

interface Part {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
}

/** One assistant message, assembled as its pieces arrive. */
export class StreamingMessage {
    private parts: Part[] = [];
    private role = 'assistant';

    reset(message?: AgentMessage): void {
        const carried = message as unknown as { role?: string; content?: Part[] } | undefined;
        this.role = carried?.role ?? 'assistant';
        this.parts = carried?.content === undefined ? [] : carried.content.map((part) => ({ ...part }));
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
                const part = this.parts[index] ?? { type: 'text', text: '' };
                part.text = `${part.text ?? ''}${String(event.delta ?? '')}`;
                this.parts[index] = part;
                break;
            }
            case 'thinking_start':
                this.parts[index] = { type: 'thinking', thinking: '' };
                break;
            case 'thinking_delta': {
                const part = this.parts[index] ?? { type: 'thinking', thinking: '' };
                part.thinking = `${part.thinking ?? ''}${String(event.delta ?? '')}`;
                this.parts[index] = part;
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
                const part = this.parts[index] ?? { type: 'toolCall', id: '', name: '', arguments: {} };
                const grown = `${(part as { raw?: string }).raw ?? ''}${String(event.delta ?? '')}`;
                (part as { raw?: string }).raw = grown;
                // The arguments arrive as json text; a half-written object is
                // not parseable, and the row shows what it can until it is.
                try {
                    part.arguments = JSON.parse(grown) as unknown;
                } catch {
                    // still arriving
                }
                this.parts[index] = part;
                break;
            }
        }
    }

    get message(): AgentMessage {
        return { role: this.role, content: this.parts } as unknown as AgentMessage;
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
            const message = (event as { message?: AgentMessage }).message;
            streaming.reset(message);
            return event;
        }
        case 'message_update': {
            const inner = (event as { assistantMessageEvent?: Record<string, unknown> }).assistantMessageEvent;
            if (inner !== undefined) streaming.apply(inner);
            return { ...event, message: streaming.message } as RpcEvent;
        }
        case 'message_end': {
            const message = (event as { message?: AgentMessage }).message;
            if (message !== undefined) streaming.reset(message);
            return event;
        }
        default:
            return event;
    }
}
