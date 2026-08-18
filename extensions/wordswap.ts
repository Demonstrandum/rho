// inspired by jola's claude code MessageDisplay word-swap hook:
// https://jola.dev/posts/how-to-stop-claude-from-saying-load-bearing
//
// two layers, deliberately separate:
//
//   message_end                  rewrites the stored message, which is the
//                                whole point: the swap enters later context.
//                                the text it stores is plain text only.
//   registerMarkdownTransformer  styles the display: red background on a
//                                swapped span, dim on the /noswap marker.
//                                pi runs it on the markdown before rendering,
//                                so nothing it does reaches the transcript.
//
// styling used to be applied in message_end, which wrote theme escapes into
// the message. an escape does not survive the round trip back into the
// model's context (the ESC byte goes, its printable tail stays), so the agent
// read `[48;2;255;234;234m` as text and copied it forward, one layer per
// turn. stripAnsi below cleans what is already stored.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
    ExtensionAPI,
    ExtensionUIContext,
    MarkdownTransformContext,
} from '@earendil-works/pi-coding-agent';
import { config } from './lib/config';

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
    source?: VerbFormOverrides;
}

export type WordValue = string | string[] | VerbEntry;

type VerbForm = 'base' | '3s' | 'past' | 'ing';

interface SwapFile {
    words: Record<string, WordValue>;
    patterns?: Record<string, string>;
}

const TRAILING_PUNCT = /[,:;.!?]/;

function makeSwap(original: string, replacements: string[]): Swap {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // capture an optional trailing punct char so we can absorb it when the
    // replacement already ends in punctuation (avoids "padding:, xyz").
    return { original, replacements, pattern: new RegExp(`\\b${escaped}\\b([,:;.!?]?)`, 'gi') };
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
    const auto = inflectVerb(sourceBase);
    const src = entry.source ?? {};
    const sourceForms = {
        '3s': src['3s'] ?? auto['3s'],
        past: src.past ?? auto.past,
        ing: src.ing ?? auto.ing,
    };
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
    // longest phrase first: applySwaps runs one .replace() per entry in this
    // order, so a shorter phrase that is a prefix of a longer one ("i
    // appreciate you" / "i appreciate you pushing") would otherwise always
    // consume its prefix out of the text before the longer entry's turn came,
    // regardless of which one the table intended to fire.
    return swaps.sort((a, b) => b.original.length - a.original.length);
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

/** case shape of a matched span, carried onto the replacement that stands in for it. */
export type CaseForm = 'verbatim' | 'upper' | 'title' | 'sentence';

// only ever used with match/replace, both of which reset lastIndex. never .test().
const WORDS = /[A-Za-z][A-Za-z'\u2019]*/g;

export function detectCase(matched: string): CaseForm {
    const words = matched.match(WORDS) ?? [];
    if (words.length === 0) return 'verbatim';
    if (!/[a-z]/.test(matched)) return 'upper';
    const capitalized = words.every((word) => /^[A-Z]/.test(word));
    const shouted = words.some((word) => word.length > 1 && word === word.toUpperCase());
    if (words.length > 1 && capitalized && !shouted) return 'title';
    if (/^[A-Z]/.test(matched)) return 'sentence';
    return 'verbatim';
}

export function applyCase(form: CaseForm, replacement: string): string {
    switch (form) {
        case 'upper':
            return replacement.toUpperCase();
        case 'title':
            return replacement.replace(WORDS, (w) => w.charAt(0).toUpperCase() + w.slice(1));
        case 'sentence':
            return replacement.replace(/[A-Za-z]/, (c) => c.toUpperCase());
        case 'verbatim':
            return replacement;
    }
}

export function applySwaps(
    text: string,
    swaps: Swap[],
    patternSwaps: PatternSwap[] = [],
    wrap?: (replaced: string) => string,
): string {
    let out = text;
    for (const { pattern, replacements } of swaps) {
        out = out.replace(pattern, (matched, trailingPunct: string) => {
            // strip the captured trailing punct from the matched text for case logic
            const core = trailingPunct ? matched.slice(0, -trailingPunct.length) : matched;
            const choice = replacements.length === 1
                ? replacements[0]
                : replacements[Math.floor(Math.random() * replacements.length)];
            const rep = applyCase(detectCase(core), choice);
            const result = wrap ? wrap(rep) : rep;
            // absorb trailing punct when the replacement already ends in punct
            if (trailingPunct && TRAILING_PUNCT.test(choice)) return result;
            return result + trailingPunct;
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
            const rep = applyCase(detectCase(matched), result);
            return wrap ? wrap(rep) : rep;
        });
    }
    return out;
}

// loaded once at module init; /reload re-runs init and picks up edits.
const _file = loadSwapFile();
export const swaps = buildSwaps(_file.words);
export const patternSwaps = _file.patterns ? buildPatternSwaps(_file.patterns) : [];

// extract display values for the vocabulary.md template.
// values are always string[] so the template handles formatting.
export function extractValues(key: string, value: WordValue): [string, string[]] {
    if (typeof value === 'string') return [key, [value]];
    if (Array.isArray(value)) return [key, value as string[]];
    const templates = Array.isArray(value.verb) ? value.verb : [value.verb];
    return [key, templates];
}
export const wordEntries: [string, string[]][] = Object.entries(_file.words)
    .map(([k, v]) => extractValues(k, v));
export const patternEntries: [string, string[]][] = Object.entries(_file.patterns ?? {})
    .map(([k, v]) => [k, [v]]);

// a real escape, and the printable remains of one whose ESC was already lost
// on a trip through the model's context. the orphan forms are the ones this
// extension itself used to emit (dim, its reset, and a 24-bit background).
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const ORPHANED_SGR = /\[(?:0|2|22|39|49)m|\[(?:38|48);(?:2;\d+;\d+;\d+|5;\d+)m/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI_SGR, '').replace(ORPHANED_SGR, '');
}

/** the marker, and any backticks or stale dim remnants hugging it. */
const BYPASS_MARKER = /\/noswap/;

function escapeRegex(source: string): string {
    return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// the stored text carries no marks, so the display side finds a swapped span
// again by matching what a swap can produce. a $n slot stood for one captured
// group, which every current pattern fills with a single word.
function buildSpanPattern(replacements: readonly string[]): RegExp | null {
    const alternatives = [...new Set(replacements)]
        .filter((r) => r !== '')
        .sort((a, b) => b.length - a.length)
        .map((r) => escapeRegex(r).replace(/\\\$\d/g, '\\S+'));
    if (alternatives.length === 0) return null;
    return new RegExp(alternatives.join('|'), 'gi');
}

const SWAPPED_SPAN = buildSpanPattern([
    ...swaps.flatMap((s) => s.replacements),
    ...patternSwaps.map((p) => p.replacement),
]);

export default function (pi: ExtensionAPI) {
    if (swaps.length === 0 && patternSwaps.length === 0) return;

    pi.registerCommand('noswap', {
        description: "toggle the word filter on/off for this session",
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();
            if (arg === '') {
                config.wordswap.enabled = !config.wordswap.enabled;
            } else if (['on', 'enable', 'true', 'yes'].includes(arg)) {
                config.wordswap.enabled = true;
            } else if (['off', 'disable', 'false', 'no'].includes(arg)) {
                config.wordswap.enabled = false;
            } else {
                ctx.ui.notify(`unknown argument: ${arg}`, 'error');
                return;
            }
            ctx.ui.notify(config.wordswap.enabled ? 'word filter on' : 'word filter off', 'info');
        },
    });

    // the theme is read per render so a /theme switch is picked up.
    let ui: ExtensionUIContext | undefined;
    pi.on('session_start', async (_event, ctx) => {
        ui = ctx.ui;
    });

    pi.on('message_end', async (event) => {
        const message = event.message;
        if (message.role !== 'assistant') return;
        if (typeof message.content === 'string') return;

        // one marker anywhere in the message exempts all of it.
        const bypass = !config.wordswap.enabled || message.content.some(
            (block) => block.type === 'text' && BYPASS_MARKER.test(block.text),
        );

        let changed = false;
        const content = message.content.map((block) => {
            if (block.type !== 'text') return block;
            const clean = stripAnsi(block.text);
            const text = bypass ? clean : applySwaps(clean, swaps, patternSwaps);
            if (text === block.text) return block;
            changed = true;
            return { ...block, text };
        });

        if (!changed) return;
        return { message: { ...message, content } };
    });

    // display only. pi hands the markdown over before rendering it, and
    // whatever comes back is styled and dropped; the message is untouched.
    pi.registerMarkdownTransformer((markdown: string, context: MarkdownTransformContext) => {
        if (context.messageType !== 'assistant') return markdown;
        const theme = ui?.theme;
        if (!theme) return markdown;

        let out = markdown;
        const bypassed = BYPASS_MARKER.test(out);
        if (SWAPPED_SPAN && config.wordswap.enabled && !bypassed) {
            out = out.replace(SWAPPED_SPAN, (span) => theme.bg('toolErrorBg', span));
        }
        return out.replace(/\/noswap/g, (marker) => theme.fg('dim', marker));
    });
}
