// inspired by jola's claude code MessageDisplay word-swap hook:
// https://jola.dev/posts/how-to-stop-claude-from-saying-load-bearing
// pi has no display-only filter, so this rewrites the stored message on
// message_end (which does enter later context) rather than just the display.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const swapsPath = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'wordswap.json');

export interface Swap {
    original: string;
    replacement: string;
    pattern: RegExp;
}

export function buildSwaps(dict: Record<string, string>): Swap[] {
    const swaps: Swap[] = [];
    for (const [original, replacement] of Object.entries(dict)) {
        const phrase = original.trim();
        if (phrase === '') continue;
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        swaps.push({
            original: phrase,
            replacement: replacement.trim(),
            pattern: new RegExp(`\\b${escaped}\\b`, 'gi'),
        });
    }
    return swaps;
}

function loadSwaps(): Swap[] {
    const dict = JSON.parse(readFileSync(swapsPath, 'utf8')) as Record<string, string>;
    return buildSwaps(dict);
}

// carry the matched text's case onto the replacement: ALL CAPS -> upper,
// Leading-cap -> capitalized, anything else -> the replacement verbatim.
function matchCase(matched: string, replacement: string): string {
    if (/[a-z]/i.test(matched) && matched === matched.toUpperCase()) {
        return replacement.toUpperCase();
    }
    if (/^[A-Z]/.test(matched)) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    }
    return replacement;
}

export function applySwaps(text: string, swaps: Swap[]): string {
    let out = text;
    for (const { pattern, replacement } of swaps) {
        out = out.replace(pattern, (matched) => matchCase(matched, replacement));
    }
    return out;
}

export function promptNote(swaps: Swap[]): string {
    const lines = swaps.map((s) => `  - "${s.original}" -> "${s.replacement}"`);
    return [
        '## vocabulary',
        '',
        'a display filter rewrites the following overused words/phrases in your',
        'finalized replies. avoid them entirely; they read as tics. the mapping',
        '(original -> what it becomes) is:',
        '',
        ...lines,
    ].join('\n');
}

export default function (pi: ExtensionAPI) {
    const swaps = loadSwaps();
    if (swaps.length === 0) return;
    const note = promptNote(swaps);

    pi.on('before_agent_start', async (event) => {
        return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
    });

    pi.on('message_end', async (event) => {
        const message = event.message;
        if (message.role !== 'assistant') return;
        if (typeof message.content === 'string') return;

        let changed = false;
        const content = message.content.map((block) => {
            if (block.type !== 'text') return block;
            const text = applySwaps(block.text, swaps);
            if (text === block.text) return block;
            changed = true;
            return { ...block, text };
        });

        if (!changed) return;
        return { message: { ...message, content } };
    });
}
