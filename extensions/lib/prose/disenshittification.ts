// normalises prose written in the house style of a model vendor's tool
// descriptions: em dashes between clauses, curly quotes, ellipsis characters,
// symbol glyphs standing in for ascii notation, invisible spacing characters.
// see system/orthography.md, o2 and o3, for the rules being applied.
//
// two properties are load-bearing here and are tested in
// tests/disenshittification.test.ts:
//
//   idempotence   f(f(x)) === f(x) for every transform and for the pipeline.
//                 the extension applies this on every session start, and the
//                 same text also reaches a human through prompt-full; a
//                 transform that keeps eating its own output would drift.
//   inertness     a protected span (fenced or inline code, a url, a path, an
//                 xml or html tag, a {{template}} directive) is masked before
//                 any substitution runs and restored afterwards, byte for byte.
//                 o6: inside those, the bytes are what a parser reads.
//
// the reflow transform (one sentence per line, o5) lives in ./reflow and is
// composed here rather than reimplemented; it is a separate concern and is
// wrong for text that a renderer does not wrap.

import { reflow, splitSentences } from './reflow';

export type TextTransform = (text: string) => string;

/** left to right: compose(a, b)(x) === b(a(x)). */
export const compose =
    (...steps: readonly TextTransform[]): TextTransform =>
    (text: string): string =>
        steps.reduce((accumulator, step) => step(accumulator), text);

// ---------------------------------------------------------------- masking

/**
 * spans whose bytes a parser reads, so no substitution may touch them.
 * order matters: a fence swallows what would otherwise look like inline code,
 * and a url swallows what would otherwise look like a path.
 */
const PROTECTED: readonly RegExp[] = [
    /^(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^(?:`{3,}|~{3,})[^\n]*$/gm, // fenced block
    /(`+)[\s\S]*?\1/g, // inline code
    /\{\{[^}]*\}\}/g, // template directive
    /<\/?[A-Za-z_][\w.:-]*(?:\s[^<>]*)?\/?>/g, // xml or html tag
    /\b[a-z][\w+.-]*:\/\/[^\s<>"'`)\]]+/gi, // url
    // a path, absolute or relative, wherever it sits: after a tag, after a
    // colon, at the start of a line. a path is a name on disk, so its case is
    // not the writer's to choose.
    /(?<![\w.@+~-])(?:~|\.{1,2})?\/[\w.@+~-]+(?:\/[\w.@+~-]+)*\/?/g, // absolute or ./ path
    // a relative path. two bare words around a slash are prose ("fetch/search",
    // "and/or"), so a path must also show an extension or a third segment.
    /(?<![\w.@+~/-])[\w.@+~-]*\.[\w.@+~-]+(?:\/[\w.@+~-]+)+\/?|(?<![\w.@+~/-])[\w.@+~-]+(?:\/[\w.@+~-]+)*\/[\w.@+~-]*\.[A-Za-z]\w{1,7}|(?<![\w.@+~/-])[\w.@+~-]+(?:\/[\w.@+~-]+){2,}\/?/g,
    // a bare filename. the extension needs two letters or more, so that the
    // "g" of "e.g." is not read as one and its stop is not made inert.
    /(?<![\w.@+~/-])[\w-]+\.[A-Za-z]\w{1,7}(?![\w/])/g,
];

// distinct from the sentinel ./reflow uses for its own code-span masking: a
// shared one collides when splitSentences runs inside a masked region here and
// unmasks placeholders it did not create.
const SENTINEL = '\u0001';

interface Masked {
    readonly text: string;
    readonly spans: readonly string[];
}

export const mask = (source: string): Masked => {
    const spans: string[] = [];
    let text = source;
    for (const pattern of PROTECTED) {
        text = text.replace(pattern, (match) => {
            spans.push(match);
            return `${SENTINEL}${spans.length - 1}${SENTINEL}`;
        });
    }
    return { text, spans };
};

export const unmask = ({ text, spans }: Masked): string =>
    text.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g'), (_, index: string) => spans[Number(index)] ?? '');

/** run a transform over the unprotected parts of the text only. */
export const overProse =
    (transform: TextTransform): TextTransform =>
    (text: string): string => {
        const masked = mask(text);
        return unmask({ text: transform(masked.text), spans: masked.spans });
    };

// ------------------------------------------------------------ substitution

interface Substitution {
    /** the orthography rule this enforces, for the report in the demo. */
    readonly rule: string;
    readonly pattern: RegExp;
    readonly replace: string | ((...groups: string[]) => string);
}

const applyAll =
    (substitutions: readonly Substitution[]): TextTransform =>
    (text: string): string =>
        substitutions.reduce(
            (accumulator, { pattern, replace }) =>
                typeof replace === 'string'
                    ? accumulator.replace(pattern, replace)
                    : accumulator.replace(pattern, (...args) => replace(...(args.slice(0, -2) as string[]))),
            text,
        );

const DASH = '[\\u2014\\u2013]'; // em, en
const CLAUSE_END = ',;:.!?';

/**
 * o2 and p5.(iv): the dash between clauses becomes the mark the sentence needs.
 * a dash that follows punctuation is deleted rather than doubled, a dash
 * between digits is a range hyphen, and every other spaced dash becomes a
 * comma. no attempt is made to guess a colon: a comma is always grammatical
 * where a parenthetical dash was, and a wrong colon is not recoverable.
 */
const DASHES: readonly Substitution[] = [
    { rule: 'o2.(iii)', pattern: new RegExp(`(\\d)\\s*${DASH}\\s*(?=\\d)`, 'g'), replace: '$1-' },
    { rule: 'p5.(iv)', pattern: new RegExp(`([${CLAUSE_END}])\\s*${DASH}\\s*`, 'g'), replace: '$1 ' },
    // a dash closing a paragraph has nothing to join, so it goes. one at the
    // end of a line with prose under it is a clause break and falls to the rule
    // below, which reads across the newline.
    { rule: 'p5.(iv)', pattern: new RegExp(`\\s*${DASH}\\s*(?=\\n\\s*\\n|$)`, 'g'), replace: '' },
    { rule: 'p5.(iv)', pattern: new RegExp(`\\s*${DASH}\\s*`, 'g'), replace: ', ' },
    // the ascii spellings of the same mark, spaced so a `--flag` is untouched.
    { rule: 'p5.(iv)', pattern: /([,;:.!?]) +-{2,3} +/g, replace: '$1 ' },
    { rule: 'p5.(iv)', pattern: / +-{2,3} +/g, replace: ', ' },
];

const CHARACTERS: readonly Substitution[] = [
    { rule: 'o2.(ii)', pattern: /[\u2018\u2019\u201b]/g, replace: "'" },
    { rule: 'o2.(ii)', pattern: /[\u201c\u201d\u201f]/g, replace: '"' },
    { rule: 'o2.(i)', pattern: /\u2026/g, replace: '...' },
    { rule: 'o2.(iv)', pattern: /\ufb01/g, replace: 'fi' },
    { rule: 'o2.(iv)', pattern: /\ufb02/g, replace: 'fl' },
    { rule: 'o2.(iv)', pattern: /\ufb00/g, replace: 'ff' },
    { rule: 'o2.(iv)', pattern: /\ufb03/g, replace: 'ffi' },
    { rule: 'o2.(iv)', pattern: /\ufb04/g, replace: 'ffl' },
    { rule: 'o2.(iii)', pattern: /\u21d2/g, replace: '=>' },
    { rule: 'o2.(iii)', pattern: /\u2192/g, replace: '->' },
    { rule: 'o2.(iii)', pattern: /\u2190/g, replace: '<-' },
    { rule: 'o2.(iii)', pattern: /\u2264/g, replace: '<=' },
    { rule: 'o2.(iii)', pattern: /\u2265/g, replace: '>=' },
    { rule: 'o2.(iii)', pattern: /\u2260/g, replace: '!=' },
    { rule: 'o2.(iii)', pattern: /\u00d7/g, replace: '*' },
    { rule: 'o2.(iii)', pattern: /\u00f7/g, replace: '/' },
    { rule: 'o2.(iii)', pattern: /\u2022/g, replace: '-' },
    { rule: 'o2.(iii)', pattern: /[\u2713\u2714]/g, replace: '[x]' },
    { rule: 'o2.(iii)', pattern: /\u00bd/g, replace: '1/2' },
    { rule: 'o2.(v)', pattern: /\u2126/g, replace: '\u03a9' },
    { rule: 'o2.(v)', pattern: /\u00b5/g, replace: '\u03bc' },
    { rule: 'o2.(vi)', pattern: /[\u00a0\u2007\u2009\u202f]/g, replace: ' ' },
    { rule: 'o2.(vi)', pattern: /[\u200b\u200e\u200f\u00ad\ufe0e\ufe0f]/g, replace: '' },
    { rule: 'o2.(vii)', pattern: /\r\n?/g, replace: '\n' },
    { rule: 'o3.(v)', pattern: /(\d)(?:\u02e2\u1d57|\u207f\u1d48|\u02b3\u1d48|\u1d57\u02b0)/g, replace: (_, digit) => `${digit}th` },
];

/**
 * names and brands keep their capitals; everything else goes to lower case.
 * a token with an internal capital (PowerShell, TypeScript) or one written in
 * capitals throughout (SDK, TUI, JSON) is already a name by its shape and needs
 * no entry here. this list is only for names spelled Like This.
 */
const NAMES: ReadonlySet<string> = new Set([
    'Anthropic', 'Claude', 'Gemini', 'Google', 'Microsoft', 'Apple', 'Amazon', 'Meta',
    // proper adjectives and the languages they name.
    'British', 'American', 'Oxford', 'Greek', 'Latin', 'French', 'German', 'Italian',
    'Spanish', 'Dutch', 'Russian', 'Chinese', 'Japanese', 'English',
    'Bun', 'Node', 'Deno', 'Docker', 'Python', 'Ruby', 'Rust', 'Perl', 'Elixir', 'Kubernetes',
    'Playwright', 'React', 'Vue', 'Svelte', 'Angular', 'Linux', 'Windows', 'Unix', 'Unicode',
    'Levenshtein', 'Porter', 'Reciprocal', 'Insight',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December',
]);

/**
 * lower case throughout, names and brands excepted (personal-rules.md, writing).
 * a capital only ever appears at a sentence start or on a name, so lowering a
 * word spelled Like This is safe when the word is not a name; a word carrying
 * an internal capital or written in capitals throughout is left alone.
 *
 * prose quoted inside a sentence is not a protected span, so a capital inside
 * quotation marks is lowered with the rest. o0.(iii) would keep it; the cost of
 * a lexicon that could tell them apart is not paid here.
 */
/** true for a word that carries its capital on its own account. */
const keepsCapital = (word: string): boolean => {
    const bare = word.replace(/['\u2019]s$/, '');
    return NAMES.has(bare) || bare === 'I' || bare.toUpperCase() === bare || /[A-Z]/.test(bare.slice(1));
};

const lower = (word: string): string => (keepsCapital(word) ? word : word.toLowerCase());

/**
 * lower case at the start of a sentence, and nowhere else (personal-rules.md,
 * writing). a capital inside a sentence is a name, an acronym, or a word the
 * writer capitalised on purpose, and no list can tell those from the rest:
 * Erdos, Kolmogorov, and every product released next year would need an entry.
 * a sentence-initial capital carries no information, so it is the only one
 * this can remove without a lexicon.
 */
export const normaliseCase: TextTransform = overProse((text) =>
    text
        // start of a line, past any list marker, blockquote mark, or opening
        // tag. a tag is a masked span by then, so the placeholder is what the
        // pattern steps over: <description>Review ... starts a sentence.
        .replace(
            new RegExp(`^([ \\t]*(?:>[ \\t]*)*(?:[-*+]|\\d+[.)])?[ \\t]*(?:${SENTINEL}\\d+${SENTINEL}[ \\t]*)*)([A-Z][\\w']*)`, 'gm'),
            (_, lead: string, word: string) => `${lead}${lower(word)}`,
        )
        // after a sentence-ending mark, or after the colon that introduces one.
        // a heading is exempt: its colon separates a title from a subtitle, and
        // the words after it are the writer's to capitalise.
        .replace(/^(?!\s{0,3}#{1,6}\s).*$/gm, (line) =>
            line.replace(/([.!?:]\s+)([A-Z][\w']*)/g, (_, lead: string, word: string) => `${lead}${lower(word)}`),
        ),
);

const SPACING: readonly Substitution[] = [
    { rule: 'o4.(i)', pattern: /([.!?]) {2,}(?=\S)/g, replace: '$1 ' },
    { rule: 'o4.(ii)', pattern: / +([;:!?%])/g, replace: '$1' },
    { rule: 'o2.(vi)', pattern: /[ \t]+$/gm, replace: '' },
];

/** o2 and o4: characters and spacing, without touching sentence structure. */
export const normaliseCharacters: TextTransform = overProse(applyAll([...CHARACTERS, ...SPACING]));

/** p5.(iv): the dash between clauses, replaced by the mark that belongs there. */
export const normaliseDashes: TextTransform = overProse(applyAll(DASHES));

/** unicode normal form C, applied to the whole text including protected spans. */
export const normaliseForm: TextTransform = (text: string): string => text.normalize('NFC');

/** o5: one sentence per line. wrong for text a renderer does not wrap. */
export const normaliseLines: TextTransform = reflow;

const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/;
const FENCE = /^\s{0,3}(?:`{3,}|~{3,})/;
// a line that ends in a path, a url, a code span, or a tag takes no stop: the
// mark would read as part of the thing it follows.
const ENDS_IN_SPAN = new RegExp(`${SENTINEL}\\d+${SENTINEL}$`);
/** the text with its protected spans and quoted values removed. */
const stripSpans = (text: string): string =>
    text.replace(new RegExp(`${SENTINEL}\\d+${SENTINEL}`, 'g'), ' ').replace(/"[^"]*"/g, ' ');

/**
 * within one list item line, sentences join with semicolons and the item closes
 * with a single stop: "x; y; z." an item is one member of an enumeration, so it
 * takes the punctuation of a clause chain rather than of a paragraph.
 *
 * a line break inside an item is the writer's and is never removed: the item
 * that arrives on one line leaves on one line, and the item already broken
 * across lines keeps its breaks. so this changes pi's single-line items and
 * leaves the ones written here, which put a sentence on each line, alone.
 */
export const normaliseBullets: TextTransform = overProse((text) => {
    let inFence = false;
    return text
        .split('\n')
        .map((line) => {
            if (FENCE.test(line)) inFence = !inFence;
            const item = inFence ? null : LIST_ITEM.exec(line);
            if (item === null) return line;

            // the stop between sentences becomes the semicolon that joins them;
            // the stop closing the item stays where the writer put it.
            // an item that states a mapping or names a value is data, not a
            // sentence: "- "seam" -> "whatchamacallit"" closes with the value
            // it gives, and a stop after it would read as part of that value.
            if (!/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(stripSpans(item[2])) || /(?:->|=>|\|)/.test(item[2])) return line;

            const sentences = splitSentences(item[2]);
            const joined = sentences
                .map((sentence, position) => (position === sentences.length - 1 ? sentence : sentence.replace(/\.$/, '')))
                .join('; ');
            // a closing bracket does not hide the mark inside it: "(etc.)" is closed.
            const bare = joined.replace(/[)\]"']+$/, '');
            const closed = /[.!?:]$/.test(bare) || ENDS_IN_SPAN.test(bare) ? joined : `${joined}.`;
            return `${item[1]}${closed}`;
        })
        .join('\n');
});

/** characters, spacing, dashes, and case. no line restructuring. */
export const disenshittify: TextTransform = compose(normaliseForm, normaliseCharacters, normaliseDashes, normaliseCase);

/** the above plus o5 line structure and list punctuation. */
export const disenshittifyMarkdown: TextTransform = compose(
    disenshittify,
    (text) => reflow(text, { listItems: 'keep' }),
    normaliseBullets,
);
