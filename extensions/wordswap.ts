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
    replacements: string[];
    pattern: RegExp;
}

export interface PatternSwap {
    source: string;
    replacement: string;
    pattern: RegExp;
}

export interface VerbFormOverrides {
    '3s'?: string;
    past?: string;
    ing?: string;
}

export interface VerbEntry {
    verb: string | string[];
    forms?: Record<string, VerbFormOverrides>;
}

export type WordValue = string | string[] | VerbEntry;

type VerbForm = 'base' | '3s' | 'past' | 'ing';

interface SwapFile {
    words: Record<string, WordValue>;
    patterns?: Record<string, string>;
}

function makeSwap(original: string, replacements: string[]): Swap {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { original, replacements, pattern: new RegExp(`\\b${escaped}\\b`, 'gi') };
}

// standard english verb inflection. covers regular cases; irregular
// replacement stems need explicit forms in the json.
export function inflectVerb(base: string): { '3s': string; past: string; ing: string } {
    const b = base.toLowerCase();

    let s3: string;
    if (/(?:s|sh|ch|x|z)$/.test(b)) s3 = b + 'es';
    else if (/[^aeiou]y$/.test(b)) s3 = b.slice(0, -1) + 'ies';
    else s3 = b + 's';

    let past: string;
    if (/e$/.test(b)) past = b + 'd';
    else if (/[^aeiou]y$/.test(b)) past = b.slice(0, -1) + 'ied';
    else if (/[^aeiou][aeiou][^aeiouwxy]$/.test(b) && b.length <= 6) past = b + b.slice(-1) + 'ed';
    else past = b + 'ed';

    let ing: string;
    if (/ie$/.test(b)) ing = b.slice(0, -2) + 'ying';
    else if (/e$/.test(b) && !/ee$/.test(b)) ing = b.slice(0, -1) + 'ing';
    else if (/[^aeiou][aeiou][^aeiouwxy]$/.test(b) && b.length <= 6) ing = b + b.slice(-1) + 'ing';
    else ing = b + 'ing';

    return { '3s': s3, past, ing };
}

function resolveTemplate(
    template: string,
    form: VerbForm,
    formOverrides: Record<string, VerbFormOverrides>,
): string {
    const m = template.match(/\{(\w+)\}/);
    if (!m) return template;
    const stem = m[1];
    let inflected: string;
    if (form === 'base') {
        inflected = stem;
    } else {
        inflected = formOverrides[stem]?.[form] ?? inflectVerb(stem)[form];
    }
    return template.replace(`{${stem}}`, inflected);
}

function buildVerbSwaps(sourceBase: string, entry: VerbEntry): Swap[] {
    const sourceForms = inflectVerb(sourceBase);
    const templates = Array.isArray(entry.verb) ? entry.verb : [entry.verb];
    const fo = entry.forms ?? {};
    const result: Swap[] = [];
    const seen = new Set<string>();

    const pairs: [VerbForm, string][] = [
        ['base', sourceBase],
        ['3s', sourceForms['3s']],
        ['past', sourceForms.past],
        ['ing', sourceForms.ing],
    ];
    for (const [formKey, sourceForm] of pairs) {
        if (seen.has(sourceForm)) continue;
        seen.add(sourceForm);
        const replacements = templates.map(t => resolveTemplate(t, formKey, fo));
        result.push(makeSwap(sourceForm, replacements));
    }
    return result;
}

export function buildSwaps(dict: Record<string, WordValue>): Swap[] {
    const swaps: Swap[] = [];
    for (const [key, value] of Object.entries(dict)) {
        const phrase = key.trim();
        if (phrase === '') continue;
        if (typeof value === 'string') {
            swaps.push(makeSwap(phrase, [value.trim()]));
        } else if (Array.isArray(value)) {
            swaps.push(makeSwap(phrase, value.map(v => v.trim())));
        } else if (typeof value === 'object' && 'verb' in value) {
            swaps.push(...buildVerbSwaps(phrase, value));
        }
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
    for (const { pattern, replacements } of swaps) {
        out = out.replace(pattern, (matched) => {
            const choice = replacements.length === 1
                ? replacements[0]
                : replacements[Math.floor(Math.random() * replacements.length)];
            const rep = matchCase(matched, choice);
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

// loaded once at module init; /reload re-runs init and picks up edits.
const _file = loadSwapFile();
export const swaps = buildSwaps(_file.words);
export const patternSwaps = _file.patterns ? buildPatternSwaps(_file.patterns) : [];

// flatten for the vocabulary.md template: [displayKey, displayValue][] pairs.
function flattenEntry(key: string, value: WordValue): [string, string] {
    if (typeof value === 'string') return [key, value];
    if (Array.isArray(value)) return [key, value.join(' | ')];
    const templates = Array.isArray(value.verb) ? value.verb : [value.verb];
    return [`${key} (all forms)`, templates.join(' | ')];
}
export const wordEntries: [string, string][] = Object.entries(_file.words)
    .map(([k, v]) => flattenEntry(k, v));
export const patternEntries = Object.entries(_file.patterns ?? {}) as [string, string][];

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
