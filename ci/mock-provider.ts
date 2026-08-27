// a minimal openai-completions server, enough for pi to run a full turn against.
//
// the smoke test needs a model that answers deterministically and costs
// nothing, so the provider is a local server rather than a real one. it speaks
// the subset pi uses: POST /v1/chat/completions with `stream: true`, plus
// GET /v1/models.
//
// the reply is scripted by turn: the first request gets a tool call (so the
// tool loop, the tool renderer, and the tool-result round trip are exercised),
// the second gets text. the text carries a word from the wordswap list, so the
// caller can check that rho's message_end hook fired.

export const MOCK_PROVIDER_ID = 'mock';
export const MOCK_MODEL_ID = 'mock-1';

/** printed by the scripted bash call; the smoke test greps for it. */
export const TOOL_MARKER = 'rho-smoke-ok';
/** in the scripted reply text; the wordswap list maps it to REPLY_SWAPPED. */
export const REPLY_TRIGGER = 'meticulous';
export const REPLY_SWAPPED = 'fussy';
export const REPLY_TEXT = `the check ran and was ${REPLY_TRIGGER}.`;

interface ChatMessage {
    readonly role: string;
    readonly content?: unknown;
}

interface ToolSchema {
    readonly type?: string;
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
}

interface ToolSpec {
    readonly type: string;
    readonly function: {
        readonly name: string;
        readonly parameters?: ToolSchema;
    };
}

interface ChatRequest {
    readonly model?: string;
    readonly messages?: readonly ChatMessage[];
    readonly tools?: readonly ToolSpec[];
}

export interface MockCall {
    readonly systemPrompt: string;
    readonly toolNames: readonly string[];
    readonly messageCount: number;
}

export interface MockProvider {
    readonly port: number;
    readonly baseUrl: string;
    readonly calls: readonly MockCall[];
    stop(): void;
}

function systemPromptOf(messages: readonly ChatMessage[]): string {
    const parts: string[] = [];
    for (const message of messages) {
        if (message.role !== 'system' && message.role !== 'developer') continue;
        if (typeof message.content === 'string') {
            parts.push(message.content);
        } else if (Array.isArray(message.content)) {
            for (const block of message.content) {
                const text = (block as { text?: unknown }).text;
                if (typeof text === 'string') parts.push(text);
            }
        }
    }
    return parts.join('\n');
}

/**
 * the scripted tool call, or null when the request carries no tool this
 * server knows how to call. the arguments are built from the advertised
 * schema rather than hardcoded, so a rename of the parameter shows up as a
 * skipped tool call instead of a rejected one.
 */
function scriptedToolCall(tools: readonly ToolSpec[]): { name: string; args: string } | null {
    const bash = tools.find((tool) => tool.function?.name === 'bash');
    if (!bash) return null;
    const properties = bash.function.parameters?.properties ?? {};
    if (!('command' in properties)) return null;
    return { name: 'bash', args: JSON.stringify({ command: `echo ${TOOL_MARKER}` }) };
}

function chunk(model: string, delta: unknown, finish: string | null): string {
    const body = {
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
    };
    return `data: ${JSON.stringify(body)}\n\n`;
}

function usageChunk(model: string): string {
    const body = {
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };
    return `data: ${JSON.stringify(body)}\n\n`;
}

function sse(text: string): Response {
    return new Response(text, {
        headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        },
    });
}

export function startMockProvider(port = 0): MockProvider {
    const calls: MockCall[] = [];

    const server = Bun.serve({
        port,
        idleTimeout: 60,
        async fetch(request) {
            const url = new URL(request.url);

            if (url.pathname === '/v1/models') {
                return Response.json({ data: [{ id: MOCK_MODEL_ID, object: 'model' }] });
            }
            if (url.pathname !== '/v1/chat/completions') {
                return new Response('not found', { status: 404 });
            }

            const body = (await request.json()) as ChatRequest;
            const messages = body.messages ?? [];
            const tools = body.tools ?? [];
            const model = body.model ?? MOCK_MODEL_ID;
            calls.push({
                systemPrompt: systemPromptOf(messages),
                toolNames: tools.map((tool) => tool.function?.name).filter((n): n is string => !!n),
                messageCount: messages.length,
            });

            const alreadyCalledTool = messages.some((message) => message.role === 'tool');
            const call = alreadyCalledTool ? null : scriptedToolCall(tools);

            if (call) {
                return sse(
                    chunk(model, { role: 'assistant', content: '' }, null)
                    + chunk(model, {
                        tool_calls: [{
                            index: 0,
                            id: 'call_mock_1',
                            type: 'function',
                            function: { name: call.name, arguments: '' },
                        }],
                    }, null)
                    + chunk(model, {
                        tool_calls: [{ index: 0, function: { arguments: call.args } }],
                    }, null)
                    + chunk(model, {}, 'tool_calls')
                    + usageChunk(model)
                    + 'data: [DONE]\n\n',
                );
            }

            let out = chunk(model, { role: 'assistant', content: '' }, null);
            for (const word of REPLY_TEXT.split(' ')) {
                out += chunk(model, { content: `${word} ` }, null);
            }
            out += chunk(model, {}, 'stop') + usageChunk(model) + 'data: [DONE]\n\n';
            return sse(out);
        },
    });

    return {
        port: server.port,
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        calls,
        stop: () => server.stop(true),
    };
}

if (import.meta.main) {
    const provider = startMockProvider(Number(process.env.MOCK_PORT ?? 0));
    console.log(provider.baseUrl);
}
