// probe: replay a stored assistant turn that holds two thinking blocks and see
// which variant anthropic accepts. run with a session file path.
//
//   bun tools/thinking-replay-probe.ts <session.jsonl> <entryIndex>
//
// prints the status and error message per variant. deletes nothing, writes
// nothing.
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

type StoredThinking = { type: 'thinking'; thinking: string; thinkingSignature: string };
type StoredToolCall = { type: 'toolCall'; id: string; name: string; arguments: unknown };
type StoredBlock = StoredThinking | StoredToolCall | { type: string; [k: string]: unknown };

interface ApiBlock {
    type: string;
    [k: string]: unknown;
}

const [sessionPath, indexArg] = process.argv.slice(2);
if (!sessionPath || !indexArg) {
    console.error('usage: bun tools/thinking-replay-probe.ts <session.jsonl> <entryIndex>');
    process.exit(1);
}

const entries = readFileSync(sessionPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
        try {
            return JSON.parse(line) as { type?: string; message?: { role?: string; content?: StoredBlock[] } };
        } catch {
            return null;
        }
    });

const target = entries[Number(indexArg)]?.message;
if (!target || !Array.isArray(target.content)) throw new Error('entry has no block content');

const userText = (() => {
    for (let i = Number(indexArg) - 1; i >= 0; i--) {
        const m = entries[i]?.message;
        if (m?.role === 'user' && Array.isArray(m.content)) {
            const text = m.content.find((b) => b.type === 'text') as { text?: string } | undefined;
            if (text?.text) return text.text;
        }
    }
    throw new Error('no preceding user message');
})();

function toApi(block: StoredBlock): ApiBlock {
    if (block.type === 'thinking') {
        const t = block as StoredThinking;
        return { type: 'thinking', thinking: t.thinking, signature: t.thinkingSignature };
    }
    if (block.type === 'toolCall') {
        const t = block as StoredToolCall;
        return { type: 'tool_use', id: t.id, name: t.name, input: t.arguments };
    }
    return { type: 'text', text: String((block as { text?: string }).text ?? '') };
}

const stored = target.content;
const apiBlocks = stored.map(toApi);
const thinkingIdx = apiBlocks.flatMap((b, i) => (b.type === 'thinking' ? [i] : []));
const toolUse = apiBlocks.find((b) => b.type === 'tool_use') as { id?: string } | undefined;

function request(assistant: ApiBlock[]): { role: string; content: unknown }[] {
    const messages: { role: string; content: unknown }[] = [
        { role: 'user', content: [{ type: 'text', text: userText }] },
        { role: 'assistant', content: assistant },
    ];
    if (toolUse?.id) {
        messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'ok' }],
        });
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: 'reply with the single word ok' }] });
    return messages;
}

const variants: [string, ApiBlock[]][] = [
    ['all blocks as stored', apiBlocks],
    ['first thinking block only', apiBlocks.filter((_, i) => i !== thinkingIdx[1])],
    ['second thinking block only', apiBlocks.filter((_, i) => i !== thinkingIdx[0])],
    [
        'both thinking blocks, whitespace text between them',
        apiBlocks.flatMap((b, i) => (i === thinkingIdx[1] ? [{ type: 'text', text: ' ' }, b] : [b])),
    ],
    [
        'both thinking blocks, empty text between them',
        apiBlocks.flatMap((b, i) => (i === thinkingIdx[1] ? [{ type: 'text', text: '' }, b] : [b])),
    ],
    [
        'first block only, empty signature',
        apiBlocks.flatMap((b, i) =>
            i === thinkingIdx[1] ? [] : i === thinkingIdx[0] ? [{ ...b, signature: '' }] : [b],
        ),
    ],
    [
        'first block only, truncated signature',
        apiBlocks.flatMap((b, i) =>
            i === thinkingIdx[1]
                ? []
                : i === thinkingIdx[0]
                  ? [{ ...b, signature: String(b.signature).slice(0, 64) }]
                  : [b],
        ),
    ],
    [
        'both thinking blocks, order reversed',
        apiBlocks.map((b, i) =>
            i === thinkingIdx[0] ? apiBlocks[thinkingIdx[1]] : i === thinkingIdx[1] ? apiBlocks[thinkingIdx[0]] : b,
        ),
    ],
    [
        'merged into one block, second signature',
        apiBlocks.flatMap((b, i) =>
            i === thinkingIdx[0]
                ? [
                      {
                          type: 'thinking',
                          thinking: `${apiBlocks[thinkingIdx[0]].thinking}${apiBlocks[thinkingIdx[1]].thinking}`,
                          signature: apiBlocks[thinkingIdx[1]].signature,
                      },
                  ]
                : i === thinkingIdx[1]
                  ? []
                  : [b],
        ),
    ],
    [
        'both thinking blocks, signatures swapped',
        apiBlocks.map((b, i) =>
            i === thinkingIdx[0]
                ? { ...b, signature: apiBlocks[thinkingIdx[1]].signature }
                : i === thinkingIdx[1]
                  ? { ...b, signature: apiBlocks[thinkingIdx[0]].signature }
                  : b,
        ),
    ],
];

const auth = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, 'utf8')) as {
    anthropic: { access?: string; accessToken?: string };
};
const token = auth.anthropic.access ?? auth.anthropic.accessToken;
if (!token) throw new Error('no anthropic access token in auth.json');

for (const [label, assistant] of variants) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
            'user-agent': 'claude-cli/2.1.75',
            'x-app': 'cli',
        },
        body: JSON.stringify({
            model: process.env.PROBE_MODEL ?? 'claude-opus-5',
            max_tokens: 2048,
            thinking: { type: 'enabled', budget_tokens: 1024 },
            system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
            messages: request(assistant),
        }),
    });
    const body = (await res.json()) as { error?: { message?: string } };
    console.log(`${res.status}  ${label}  ${body.error?.message?.slice(0, 160) ?? 'ok'}`);
}
