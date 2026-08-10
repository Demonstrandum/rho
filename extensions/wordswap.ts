// inspired by jola's claude code MessageDisplay word-swap hook:
// https://jola.dev/posts/how-to-stop-claude-from-saying-load-bearing
// pi has no display-only filter, so this rewrites the stored message on
// message_end (which does enter later context) rather than just the display.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const extDir = dirname(fileURLToPath(import.meta.url));
const swapsPath = join(extDir, 'assets', 'wordswap.json');
const templatePath = join(extDir, '..', 'system', 'vocabulary.md');

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

export function applySwaps(text: string, swaps: Swap[], patternSwaps: PatternSwap[] = []): string {
    let out = text;
    for (const { pattern, replacement } of swaps) {
        out = out.replace(pattern, (matched) => matchCase(matched, replacement));
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
            return matchCase(matched, result);
        });
    }
    return out;
}

export function promptNote(swaps: Swap[], patternSwaps: PatternSwap[] = [], template?: string): string {
    const wordLines = swaps.map((s) => `  - "${s.original}" -> "${s.replacement}"`).join('\n');
    const patternLines = patternSwaps.map((s) => `  - /${s.source}/ -> "${s.replacement}"`).join('\n');

    if (template) {
        let out = template.replace('{{WORDS}}', wordLines);
        if (patternSwaps.length > 0) {
            out = out.replace('{{PATTERNS}}', patternLines);
        } else {
            // strip the patterns section entirely when there are none.
            out = out.replace(/\n*pattern swaps[^\n]*\n*\{\{PATTERNS\}\}\n*/g, '');
        }
        return out.trimEnd();
    }

    // fallback: no template file available (e.g. in tests).
    const parts = [wordLines];
    if (patternSwaps.length > 0) {
        parts.push('\npattern swaps (regex, applied to coined compounds):\n');
        parts.push(patternLines);
    }
    return parts.join('\n');
}

export default function (pi: ExtensionAPI) {
    const file = loadSwapFile();
    const swaps = buildSwaps(file.words);
    const patternSwaps = file.patterns ? buildPatternSwaps(file.patterns) : [];
    if (swaps.length === 0 && patternSwaps.length === 0) return;

    let template: string | undefined;
    try { template = readFileSync(templatePath, 'utf8'); } catch { /* use inline fallback */ }
    const note = promptNote(swaps, patternSwaps, template);

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
            const text = applySwaps(block.text, swaps, patternSwaps);
            if (text === block.text) return block;
            changed = true;
            return { ...block, text };
        });

        if (!changed) return;
        return { message: { ...message, content } };
    });
}
