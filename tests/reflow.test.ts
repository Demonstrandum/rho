import { describe, expect, test } from 'bun:test';
import { reflow, splitSentences } from '../tools/reflow';

describe('splitSentences', () => {
    test('splits on sentence ends regardless of the next word\'s case', () => {
        expect(splitSentences('one thing. another thing.')).toEqual(['one thing.', 'another thing.']);
    });

    test('keeps abbreviations whole', () => {
        expect(splitSentences('a marker (e.g. this one) stays.')).toEqual(['a marker (e.g. this one) stays.']);
        expect(splitSentences('see vol. 2 for more.')).toEqual(['see vol. 2 for more.']);
    });

    test('keeps an ellipsis whole', () => {
        expect(splitSentences('the notice "auth ... billed per token" is gone.')).toEqual([
            'the notice "auth ... billed per token" is gone.',
        ]);
    });

    test('ignores punctuation inside a code span', () => {
        expect(splitSentences('use `a. b` here. done.')).toEqual(['use `a. b` here.', 'done.']);
    });

    test('does not split a rule label', () => {
        expect(splitSentences('o5.(i) one sentence, one line.')).toEqual(['o5.(i) one sentence, one line.']);
    });
});

describe('reflow', () => {
    test('unwraps a paragraph', () => {
        expect(reflow('a first sentence that was\nwrapped. a second one.\n')).toBe(
            'a first sentence that was wrapped.\na second one.\n',
        );
    });

    test('leaves fenced code untouched', () => {
        const source = '```\nlet x = 1. let y = 2.\n```\n';
        expect(reflow(source)).toBe(source);
    });

    test('leaves tables, quotes, and front matter untouched', () => {
        const source = '---\nname: x. y\n---\n\n| a. b | c |\n|---|---|\n\n> quoted. text\n';
        expect(reflow(source)).toBe(source);
    });

    test('indents list continuations under the marker', () => {
        expect(reflow('  - first. second.\n')).toBe('  - first.\n    second.\n');
    });

    test('leaves template directive lines alone', () => {
        const source = '{{#if patterns.length > 0}}\ntext here. more.\n{{/if}}\n';
        expect(reflow(source)).toBe('{{#if patterns.length > 0}}\ntext here.\nmore.\n{{/if}}\n');
    });

    test('normalises decomposed characters to NFC', () => {
        const decomposed = 'A\u030A and coo\u0308perate.\n';
        expect(reflow(decomposed)).toBe('\u00C5 and co\u00F6perate.\n');
    });

    test('is idempotent', () => {
        const source = '# h\n\nsome prose. more prose that\nwraps.\n\n- a. b\n';
        const once = reflow(source);
        expect(reflow(once)).toBe(once);
    });
});
