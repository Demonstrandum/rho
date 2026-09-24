// one sentence per line (o5 in system/orthography.md), for markdown.
// exempt: fenced code, indented code, tables, front matter, blockquotes, html.
// the cli wrapper is tools/reflow.ts; extensions compose this from
// ./disenshittification.
//
// a paragraph containing an xml or html tag is left on its line. a split
// inside <t>abc. def</t> would leave the closing tag stranded on a line of its
// own, and no sentence-level rule recovers the pairing.

type LineKind =
    | 'blank'
    | 'exempt'
    | 'heading'
    | 'prose'
    | 'list-item';

interface Classified {
    readonly kind: LineKind;
    readonly text: string;
    /** for list-item: the marker plus its trailing space, e.g. "- " or "  1. " */
    readonly marker: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/;
const TABLE_ROW = /^\s*\|/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const BLOCKQUOTE = /^\s*>/;
const HTML_BLOCK = /^\s*<[a-zA-Z/!]/;
const THEMATIC = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const INDENTED_CODE = /^ {4,}\S/;
// prompt templates: handlebars-style directives own their line.
const TEMPLATE_LINE = /^\s*\{\{|\}\}\s*$/;
// an inline tag anywhere in a paragraph pins that paragraph to one line.
const MARKUP = /<\/?[A-Za-z_][\w.:-]*(?:\s[^<>]*)?\/?>/;
const TAG = /<(\/?)([A-Za-z_][\w.:-]*)(?:\s[^<>]*?)?(\/?)>/g;

/**
 * the depth change a line makes to the open-tag stack. a block a tag opens and
 * does not close on the same line holds text whose line breaks belong to
 * whoever wrote the block, not to markdown: an <env> listing, a skill
 * <description>, a <project_instructions> body. reflow does not cross it.
 */
const tagDelta = (line: string): number => {
    let delta = 0;
    for (const match of line.matchAll(TAG)) {
        const [, closing, , selfClosing] = match;
        if (selfClosing === '/') continue;
        delta += closing === '/' ? -1 : 1;
    }
    return delta;
};

// abbreviations whose period never ends a sentence.
const ABBREVIATIONS: ReadonlySet<string> = new Set([
    'e.g.', 'i.e.', 'etc.', 'cf.', 'vs.', 'al.', 'approx.', 'ca.', 'ibid.',
    'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'St.', 'Ltd.', 'Inc.', 'Co.',
    'vol.', 'no.', 'No.', 'ed.', 'eds.', 'fig.', 'Fig.', 'sec.', 'ch.', 'pp.',
    'Jan.', 'Feb.', 'Mar.', 'Apr.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Sept.',
    'Oct.', 'Nov.', 'Dec.', 'a.m.', 'p.m.', 'U.S.', 'U.K.',
]);

const isAbbreviation = (raw: string): boolean => {
    // an abbreviation can open with a bracket or a quote: "(e.g."
    const token = raw.replace(/^[(\["'‘“]+/, '');
    if (ABBREVIATIONS.has(token)) return true;
    // single initial: "J." or "o." ; also multi-dot forms like "U.S.S.R."
    if (/^[A-Za-z]\.$/.test(token)) return true;
    if (/^(?:[A-Za-z]\.){2,}$/.test(token)) return true;
    return false;
};

/** replace inline code spans with placeholders so their punctuation is inert. */
const maskCode = (text: string): { masked: string; spans: string[] } => {
    const spans: string[] = [];
    const masked = text.replace(/(`+)([\s\S]*?)\1/g, (match) => {
        spans.push(match);
        return `\u0000${spans.length - 1}\u0000`;
    });
    return { masked, spans };
};

const unmaskCode = (text: string, spans: readonly string[]): string =>
    text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => spans[Number(index)] ?? '');

/** split a joined paragraph into sentences, one per returned entry. */
export const splitSentences = (paragraph: string): string[] => {
    const { masked, spans } = maskCode(paragraph);
    if (MARKUP.test(masked)) return [unmaskCode(masked, spans)];
    const out: string[] = [];
    let start = 0;
    const boundary = /([.!?])(["'’\)\]]*)(\s+)(?=\S)/g;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(masked)) !== null) {
        const end = match.index + match[1].length + match[2].length;
        const head = masked.slice(start, end);
        const trimmed = head.trimEnd();
        if (trimmed.endsWith('..')) continue; // an ellipsis is not a sentence end
        const lastToken = trimmed.split(/\s+/).pop() ?? '';
        if (isAbbreviation(lastToken)) continue;
        // the following word's case decides nothing: this repo writes prose in
        // lower case, so an abbreviation list is the only guard available.
        out.push(head.trim());
        start = end + match[3].length;
    }
    const tail = masked.slice(start).trim();
    if (tail.length > 0) out.push(tail);
    return out.map((sentence) => unmaskCode(sentence, spans));
};

const classify = (line: string): Classified => {
    if (line.trim().length === 0) return { kind: 'blank', text: line, marker: '' };
    if (HEADING.test(line)) return { kind: 'heading', text: line, marker: '' };
    if (
        TABLE_ROW.test(line) ||
        BLOCKQUOTE.test(line) ||
        HTML_BLOCK.test(line) ||
        THEMATIC.test(line) ||
        TEMPLATE_LINE.test(line) ||
        INDENTED_CODE.test(line)
    ) {
        return { kind: 'exempt', text: line, marker: '' };
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) return { kind: 'list-item', text: item[2], marker: item[1] };
    return { kind: 'prose', text: line.trim(), marker: '' };
};

export interface ReflowOptions {
    /**
     * 'split' gives a list item the same treatment as prose, one sentence per
     * line with the continuation indented (o5.(iii)). 'keep' leaves the item's
     * lines as the writer set them, for a caller that punctuates items itself.
     */
    readonly listItems?: 'split' | 'keep';
}

export const reflow = (source: string, options: ReflowOptions = {}): string => {
    const listItems = options.listItems ?? 'split';
    // o2.(v): two byte sequences that render alike are normalised to one.
    const lines = source.normalize('NFC').split('\n');
    const out: string[] = [];
    let index = 0;
    let inFence = false;
    let fenceMarker = '';
    let inFrontMatter = lines[0]?.trim() === '---';
    let tagDepth = 0;

    while (index < lines.length) {
        const line = lines[index];

        if (inFrontMatter) {
            out.push(line);
            if (index > 0 && line.trim() === '---') inFrontMatter = false;
            index += 1;
            continue;
        }

        const fence = FENCE.exec(line);
        if (fence !== null) {
            if (!inFence) {
                inFence = true;
                fenceMarker = fence[1][0];
            } else if (fence[1][0] === fenceMarker) {
                inFence = false;
            }
            out.push(line);
            index += 1;
            continue;
        }
        if (inFence) {
            out.push(line);
            index += 1;
            continue;
        }

        // inside an unclosed tag, every line is the writer's.
        if (tagDepth > 0) {
            out.push(line);
            tagDepth = Math.max(0, tagDepth + tagDelta(line));
            index += 1;
            continue;
        }
        const opened = tagDelta(line);
        if (opened > 0) {
            out.push(line);
            tagDepth = opened;
            index += 1;
            continue;
        }

        const classified = classify(line);
        if (classified.kind !== 'prose' && classified.kind !== 'list-item') {
            out.push(line);
            index += 1;
            continue;
        }
        if (classified.kind === 'list-item' && listItems === 'keep') {
            out.push(line);
            index += 1;
            // the item's continuation lines are the writer's too.
            while (index < lines.length) {
                const next = lines[index];
                if (next.trim().length === 0 || !/^\s/.test(next) || FENCE.test(next)) break;
                out.push(next);
                index += 1;
            }
            continue;
        }

        // gather the block: the starting line plus its continuation lines.
        const marker = classified.marker;
        const continuationIndent = marker.length > 0 ? ' '.repeat(marker.length) : '';
        const parts: string[] = [classified.text];
        let cursor = index + 1;
        while (cursor < lines.length) {
            const next = classify(lines[cursor]);
            if (next.kind !== 'prose') break;
            if (FENCE.test(lines[cursor])) break;
            parts.push(next.text);
            cursor += 1;
        }
        const sentences = splitSentences(parts.join(' '));
        sentences.forEach((sentence, position) => {
            out.push(position === 0 ? `${marker}${sentence}` : `${continuationIndent}${sentence}`);
        });
        index = cursor;
    }

    return out.join('\n');
};
