// one agent run, read back from pi's --mode json event stream.
//
// assistant text is taken from each block's text_end, which carries what the
// model wrote. message_end is the stored message, and wordswap.ts rewrites
// that in place, so a banned word would already be a substitute there.
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';

export interface ToolUse {
    readonly id: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
    result: string;
    isError: boolean;
}

export interface Turn {
    /** the text blocks of one assistant message, as the model wrote them. */
    readonly texts: string[];
    readonly tools: ToolUse[];
}

export interface Transcript {
    readonly turns: Turn[];
    /** every assistant text block, in order, joined by blank lines. */
    readonly prose: string;
    /** the text of the last assistant message that has any. */
    readonly reply: string;
    readonly tools: readonly ToolUse[];
    readonly costUsd: number;
    readonly outputTokens: number;
    readonly error: string | null;
}

function textOf(content: unknown): string {
    if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
    return content
        .map((block) => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
            ? String((block as { text?: unknown }).text ?? '')
            : ''))
        .join('');
}

export function parseTranscript(jsonl: string): Transcript {
    const turns: Turn[] = [];
    const byId = new Map<string, ToolUse>();
    let current: Turn | null = null;
    let costUsd = 0;
    let outputTokens = 0;
    let error: string | null = null;

    for (const line of jsonl.split('\n')) {
        if (line.trim() === '') continue;
        let event: JsonAgentSessionEvent;
        try {
            event = JSON.parse(line) as JsonAgentSessionEvent;
        } catch {
            continue;
        }
        switch (event.type) {
            case 'message_start':
                if (event.message.role === 'assistant') {
                    current = { texts: [], tools: [] };
                    turns.push(current);
                }
                break;
            case 'message_update': {
                const inner = event.assistantMessageEvent;
                if (inner.type === 'text_end' && current) current.texts.push(inner.content);
                break;
            }
            case 'message_end': {
                if (event.message.role !== 'assistant' || !current) break;
                const message = event.message as AssistantMessage;
                for (const block of message.content) {
                    if (block.type !== 'toolCall') continue;
                    const use: ToolUse = { id: block.id, name: block.name, args: block.arguments, result: '', isError: false };
                    current.tools.push(use);
                    byId.set(block.id, use);
                }
                costUsd += message.usage.cost.total;
                outputTokens += message.usage.output;
                if (message.stopReason === 'error') error = message.errorMessage ?? 'provider error';
                break;
            }
            case 'tool_execution_end': {
                const use = byId.get(event.toolCallId);
                if (use) {
                    use.result = textOf((event.result as { content?: unknown } | undefined)?.content);
                    use.isError = event.isError;
                }
                break;
            }
            default:
                break;
        }
    }

    const texts = turns.flatMap((turn) => turn.texts).filter((text) => text.trim() !== '');
    const last = [...turns].reverse().find((turn) => turn.texts.some((text) => text.trim() !== ''));
    return {
        turns,
        prose: texts.join('\n\n'),
        reply: last ? last.texts.join('\n\n') : '',
        tools: turns.flatMap((turn) => turn.tools),
        costUsd,
        outputTokens,
        error,
    };
}

/**
 * every string a tool call could have executed: bash commands, codemode
 * scripts, context-mode code and batches. good enough for "did it ever run
 * git stash"; not a shell parser.
 */
export function executed(transcript: Transcript): string[] {
    const out: string[] = [];
    for (const use of transcript.tools) {
        if (use.name === 'read' || use.name === 'write' || use.name === 'edit') continue;
        out.push(JSON.stringify(use.args));
    }
    return out;
}

/** a readable rendering for the judge, with long tool output cut. */
export function renderTranscript(transcript: Transcript, limit = 1500): string {
    const cut = (text: string): string => (text.length > limit ? `${text.slice(0, limit)}\n[... ${text.length - limit} more characters]` : text);
    const out: string[] = [];
    for (const turn of transcript.turns) {
        for (const text of turn.texts) if (text.trim() !== '') out.push(`<assistant>\n${text}\n</assistant>`);
        for (const use of turn.tools) {
            out.push(`<tool_call name="${use.name}">\n${cut(JSON.stringify(use.args, null, 2))}\n</tool_call>`);
            out.push(`<tool_result error="${use.isError}">\n${cut(use.result)}\n</tool_result>`);
        }
    }
    return out.join('\n');
}
