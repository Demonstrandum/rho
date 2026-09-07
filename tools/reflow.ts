#!/usr/bin/env bun
// rewrites markdown prose to one sentence per line (o5 in system/orthography.md).
// exempt: fenced code, indented code, tables, front matter, blockquotes, html.

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

export const reflow = (source: string): string => {
    const lines = source.split('\n');
    const out: string[] = [];
    let index = 0;
    let inFence = false;
    let fenceMarker = '';
    let inFrontMatter = lines[0]?.trim() === '---';

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

        const classified = classify(line);
        if (classified.kind !== 'prose' && classified.kind !== 'list-item') {
            out.push(line);
            index += 1;
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

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const paths = args.filter((arg) => !arg.startsWith('--'));
    if (paths.length === 0) {
        console.error('usage: bun tools/reflow.ts [--write] <file.md>...');
        process.exit(2);
    }
    for (const path of paths) {
        const source = await Bun.file(path).text();
        const result = reflow(source);
        const twice = reflow(result);
        if (twice !== result) {
            console.error(`${path}: not idempotent, refusing`);
            process.exit(1);
        }
        if (result === source) {
            console.log(`${path}: unchanged`);
            continue;
        }
        if (write) {
            await Bun.write(path, result);
            console.log(`${path}: rewritten`);
        } else {
            console.log(`${path}: would change`);
        }
    }
};

if (import.meta.main) await main();
