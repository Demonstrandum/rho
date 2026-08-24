import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// anthropic's messages api rejects a replayed assistant turn that carries two
// `thinking` blocks side by side:
//
//   400 messages.N.content.1: `thinking` or `redacted_thinking` blocks in the
//   latest assistant message cannot be modified. These blocks must remain as
//   they were in the original response.
//
// the model streams one content block per thinking segment, and pi stores and
// replays them one for one, so a turn that thought twice can never be sent
// again: every later request in that session repeats the pair and fails.
//
// probed against the live api with the stored blocks of such a turn, replayed
// to the model that produced them (tools/thinking-replay-probe.ts). the rule is
// adjacency, not block content: either block alone is accepted, both together
// are rejected in either order and rejected again with the signatures swapped,
// one text block between them is accepted, and so are the two thinking texts
// joined into a single block under the later signature. an empty or truncated
// signature is rejected, so the signature is verified throughout. sending the
// pair to a different model is accepted, but that only shows that a model does
// not validate signatures it did not produce.
//
// this collapses each run of adjacent thinking blocks in the outgoing anthropic
// payload into one block holding the concatenated text and the last signature.
// the fix belongs in the anthropic adapter's serialization; this is the local
// version of it.

export interface ThinkingBlock {
    type: 'thinking';
    thinking: string;
    signature: string;
}

export type ContentBlock = ThinkingBlock | { type: string };

interface ProviderMessage {
    role: string;
    content: string | ContentBlock[];
}

interface AnthropicPayload {
    messages: ProviderMessage[];
}

function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
    if (block.type !== 'thinking') return false;
    const candidate = block as Partial<ThinkingBlock>;
    return typeof candidate.thinking === 'string' && typeof candidate.signature === 'string';
}

// the anthropic messages payload is the only provider payload whose reasoning
// blocks are `{ type: 'thinking', thinking, signature }`, so the block shape
// identifies it and no provider name is needed.
function isAnthropicPayload(payload: unknown): payload is AnthropicPayload {
    if (typeof payload !== 'object' || payload === null) return false;
    const messages = (payload as Partial<AnthropicPayload>).messages;
    if (!Array.isArray(messages)) return false;
    return messages.every(
        (message) =>
            typeof message === 'object' &&
            message !== null &&
            typeof (message as ProviderMessage).role === 'string' &&
            (typeof (message as ProviderMessage).content === 'string' ||
                Array.isArray((message as ProviderMessage).content)),
    );
}

/**
 * collapse every run of adjacent thinking blocks into one block. returns null
 * when no run is longer than one block, so an untouched payload is passed on by
 * reference rather than rebuilt.
 */
export function mergeThinkingRuns(blocks: ContentBlock[]): ContentBlock[] | null {
    const merged: ContentBlock[] = [];
    let run: ThinkingBlock[] = [];

    const flush = () => {
        if (run.length === 0) return;
        merged.push(
            run.length === 1
                ? run[0]
                : {
                      type: 'thinking',
                      thinking: run.map((block) => block.thinking).join(''),
                      signature: run[run.length - 1].signature,
                  },
        );
        run = [];
    };

    for (const block of blocks) {
        if (isThinkingBlock(block)) {
            run.push(block);
            continue;
        }
        flush();
        merged.push(block);
    }
    flush();

    return merged.length === blocks.length ? null : merged;
}

export default function (pi: ExtensionAPI) {
    pi.on('before_provider_request', (event) => {
        const payload = event.payload;
        if (!isAnthropicPayload(payload)) return;

        let changed = false;
        const messages = payload.messages.map((message) => {
            if (message.role !== 'assistant' || typeof message.content === 'string') return message;
            const merged = mergeThinkingRuns(message.content);
            if (!merged) return message;
            changed = true;
            return { ...message, content: merged };
        });

        if (!changed) return;
        return { ...payload, messages };
    });
}
