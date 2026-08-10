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

export interface PatternSwap {
    source: string;
    replacement: string;
    pattern: RegExp;
}

interface SwapFile {
    words: Record<string, string>;
    patterns?: Record<string, string>;
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

export function buildPatternSwaps(dict: Record<string, string>): PatternSwap[] {
    const swaps: PatternSwap[] = [];
    for (const [source, replacement] of Object.entries(dict)) {
        const src = source.trim();
        if (src === '') continue;
        swaps.push({
            source: src,
            replacement: replacement.trim(),
            pattern: new RegExp(`\\b${src}\\b`, 'gi'),
        });
    }
    return swaps;
}

function loadSwapFile(): SwapFile {
    const raw = JSON.parse(readFileSync(swapsPath, 'utf8'));
    // backward compat: flat dict (no 'words' key) is all word swaps.
    if (raw && typeof raw === 'object' && !raw.words) {
        return { words: raw as Record<string, string> };
    }
    return raw as SwapFile;
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

export function applySwaps(
    text: string,
    swaps: Swap[],
    patternSwaps: PatternSwap[] = [],
    wrap?: (replaced: string) => string,
): string {
    let out = text;
    for (const { pattern, replacement } of swaps) {
        out = out.replace(pattern, (matched) => {
            const rep = matchCase(matched, replacement);
            return wrap ? wrap(rep) : rep;
        });
    }
    for (const { pattern, replacement } of patternSwaps) {
        out = out.replace(pattern, (...args) => {
            // args: matched, ...captures, offset, fullString
            const matched = args[0] as string;
            let result = replacement;
            // substitute $1, $2, etc. with captured groups.
            for (let i = 1; i < args.length - 2; i++) {
                if (typeof args[i] === 'string') {
                    result = result.replace(`$${i}`, args[i] as string);
                }
            }
            const rep = matchCase(matched, result);
            return wrap ? wrap(rep) : rep;
        });
    }
    return out;
}

export function formatWordLines(items: Swap[]): string {
    return items.map((s) => `  - "${s.original}" -> "${s.replacement}"`).join('\n');
}

export function formatPatternLines(items: PatternSwap[]): string {
    if (items.length === 0) return '';
    const lines = items.map((s) => `  - /${s.source}/ -> "${s.replacement}"`).join('\n');
    return `\npattern swaps (regex, applied to coined compounds):\n\n${lines}`;
}

// loaded once at module init; /reload re-runs init and picks up edits.
const _file = loadSwapFile();
export const swaps = buildSwaps(_file.words);
export const patternSwaps = _file.patterns ? buildPatternSwaps(_file.patterns) : [];

export default function (pi: ExtensionAPI) {
    if (swaps.length === 0 && patternSwaps.length === 0) return;

    const BYPASS_MARKER = /\/noswap/g;

    pi.on('message_end', async (event, ctx) => {
        const highlight = (s: string) => ctx.ui.theme.bg('toolErrorBg', s);
        const message = event.message;
        if (message.role !== 'assistant') return;
        if (typeof message.content === 'string') return;

        // check if any text block contains the bypass marker
        const bypass = message.content.some(
            (block) => block.type === 'text' && BYPASS_MARKER.test(block.text),
        );

        let changed = false;
        const content = message.content.map((block) => {
            if (block.type !== 'text') return block;
            let text = block.text;
            // dim the marker so it stays in the text (KV cache) but is unobtrusive
            const DIM = '\x1b[2m';
            const RESET = '\x1b[22m';
            const dimmed = text.replace(BYPASS_MARKER, `${DIM}/noswap${RESET}`);
            if (dimmed !== text) {
                text = dimmed;
                changed = true;
            }
            if (!bypass) {
                const swapped = applySwaps(text, swaps, patternSwaps, highlight);
                if (swapped !== text) {
                    text = swapped;
                    changed = true;
                }
            }
            if (text === block.text) return block;
            return { ...block, text };
        });

        if (!changed) return;
        return { message: { ...message, content } };
    });
}
