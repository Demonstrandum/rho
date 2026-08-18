import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSwaps, buildPatternSwaps, applySwaps, inflectVerb } from '../extensions/wordswap';
import type { WordValue } from '../extensions/wordswap';
import { SourceStr, parseSpans, stripMarkers, wrapRawDict, mark } from '../extensions/lib/source-str';

const dict = { 'load-bearing': 'cooked', 'honest take': 'spicy doodad', seam: 'whatchamacallit' };

test('buildSwaps yields one case-insensitive, word-bounded rule per entry', () => {
    const swaps = buildSwaps(dict);
    console.log('rules:', swaps.map((s) => `${s.original}->${s.replacements[0]}`).join(', '));
    expect(swaps).toHaveLength(3);
    for (const s of swaps) expect(s.pattern.flags).toBe('gi');
});

test('applySwaps replaces every match regardless of case', () => {
    const swaps = buildSwaps(dict);
    const input = 'a seam here and a seam there.';
    const out = applySwaps(input, swaps);
    console.log('in: ', input);
    console.log('out:', out);
    expect(out).toBe('a whatchamacallit here and a whatchamacallit there.');
});

test('applySwaps carries the matched case onto the replacement', () => {
    const swaps = buildSwaps(dict);
    const check = (input: string, expected: string) => {
        const out = applySwaps(input, swaps);
        console.log('in: ', input);
        console.log('out:', out);
        expect(out).toBe(expected);
    };
    check('seam Seam SEAM; Load-Bearing and LOAD-BEARING.', 'whatchamacallit Whatchamacallit WHATCHAMACALLIT; Cooked and COOKED.');
    // multi-word phrase: leading cap capitalizes only the first word.
    check('Honest take, please.', 'Spicy doodad, please.');
    check('HONEST TAKE!', 'SPICY DOODAD!');
});

test('applySwaps respects word boundaries and leaves non-matches alone', () => {
    const swaps = buildSwaps(dict);
    // "seams" and "seamless" should not match the "seam" rule.
    const input = 'seamless seams stay put, the load-bearing wall does not.';
    const out = applySwaps(input, swaps);
    console.log('in: ', input);
    console.log('out:', out);
    expect(out).toBe('seamless seams stay put, the cooked wall does not.');
});

test('applySwaps is a no-op when nothing matches', () => {
    const swaps = buildSwaps(dict);
    const text = 'nothing here to change at all.';
    const out = applySwaps(text, swaps);
    console.log('in: ', text);
    console.log('out:', out);
    expect(out).toBe(text);
});

test('buildSwaps escapes regex metacharacters and skips blank keys', () => {
    // the '.' must be literal: 'a.b' and 'node.js' should not match 'axb' / 'nodexjs'.
    const swaps = buildSwaps({ 'a.b': 'ab', '  ': 'ignored', 'node.js': 'bun' });
    console.log('escaped rules:', swaps.map((s) => s.original).join(', '));
    expect(swaps).toHaveLength(2);
    const input = 'a.b matches, axb does not; node.js goes, nodexjs stays.';
    const out = applySwaps(input, swaps);
    console.log('in: ', input);
    console.log('out:', out);
    expect(out).toBe('ab matches, axb does not; bun goes, nodexjs stays.');
});

test('the shipped wordswap.json builds into a valid rule set', () => {
    const shipped = JSON.parse(
        readFileSync(join(import.meta.dir, '..', 'extensions', 'assets', 'wordswap.json'), 'utf8'),
    ) as { words: Record<string, string>; patterns?: Record<string, string> };
    const swaps = buildSwaps(shipped.words);
    expect(swaps.length).toBeGreaterThan(0);
    expect(swaps.some(s => s.original === 'load-bearing')).toBe(true);
});

test('verb entries generate inflected swaps', () => {
    const dict: Record<string, WordValue> = {
        'showcase': { verb: '{show} off' },
    };
    const swaps = buildSwaps(dict);
    const originals = swaps.map(s => s.original);
    console.log('verb forms:', originals.join(', '));
    expect(originals).toContain('showcase');
    expect(originals).toContain('showcases');
    expect(originals).toContain('showcased');
    expect(originals).toContain('showcasing');

    const base = swaps.find(s => s.original === 'showcase')!;
    expect(base.replacements[0]).toBe('show off');
    const s3 = swaps.find(s => s.original === 'showcases')!;
    expect(s3.replacements[0]).toBe('shows off');
    const past = swaps.find(s => s.original === 'showcased')!;
    expect(past.replacements[0]).toBe('showed off');
    const ing = swaps.find(s => s.original === 'showcasing')!;
    expect(ing.replacements[0]).toBe('showing off');
});

test('verb entries with irregular forms use overrides', () => {
    const dict: Record<string, WordValue> = {
        'delve': {
            verb: '{dig} with my little paws',
            forms: { dig: { '3s': 'digs', past: 'dug', ing: 'digging' } },
        },
    };
    const swaps = buildSwaps(dict);
    const past = swaps.find(s => s.original === 'delved')!;
    expect(past.replacements[0]).toBe('dug with my little paws');
    const ing = swaps.find(s => s.original === 'delving')!;
    expect(ing.replacements[0]).toBe('digging with my little paws');
});

test('alternatives produce multiple replacements', () => {
    const dict: Record<string, WordValue> = {
        'seamless': ['wibbly', 'dodecahedral', 'with no wibbly bits'],
    };
    const swaps = buildSwaps(dict);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].replacements).toEqual(['wibbly', 'dodecahedral', 'with no wibbly bits']);
});

test('verb entries with irregular source forms use source overrides', () => {
    const dict: Record<string, WordValue> = {
        'run': {
            verb: '{sprint}',
            source: { past: 'ran', ing: 'running' },
        },
    };
    const swaps = buildSwaps(dict);
    const originals = swaps.map(s => s.original);
    expect(originals).toContain('run');
    expect(originals).toContain('runs');
    expect(originals).toContain('ran');
    expect(originals).toContain('running');
    expect(originals).not.toContain('runned');
    expect(originals).not.toContain('runing');
});

test('irregular source and irregular replacement inflect independently', () => {
    const dict: Record<string, WordValue> = {
        'run': {
            verb: '{spring}',
            source: { past: 'ran', ing: 'running' },
            forms: { spring: { '3s': 'springs', past: 'sprung', ing: 'springing' } },
        },
    };
    const swaps = buildSwaps(dict);
    const find = (src: string) => swaps.find(s => s.original === src)!;
    expect(find('run').replacements[0]).toBe('spring');
    expect(find('runs').replacements[0]).toBe('springs');
    expect(find('ran').replacements[0]).toBe('sprung');
    expect(find('running').replacements[0]).toBe('springing');
});

test('trailing punctuation is absorbed when replacement ends in punct', () => {
    const swaps = buildSwaps({
        'in conclusion': 'padding:',
        'the key insight is': 'something I just made up:',
    });
    // comma after "in conclusion" is absorbed by the colon in "padding:"
    const out1 = applySwaps('In conclusion, we found nothing.', swaps);
    console.log('punct1:', out1);
    expect(out1).toBe('Padding: we found nothing.');

    // no trailing punct: replacement appears as-is
    const out2 = applySwaps('In conclusion we found nothing.', swaps);
    console.log('punct2:', out2);
    expect(out2).toBe('Padding: we found nothing.');

    // period after the phrase is absorbed
    const out3 = applySwaps('The key insight is.', swaps);
    console.log('punct3:', out3);
    expect(out3).toBe('Something I just made up:');
});

test('trailing punctuation is kept when replacement does not end in punct', () => {
    const swaps = buildSwaps({ 'tapestry': 'big rug' });
    const out = applySwaps('a tapestry, woven by hand.', swaps);
    console.log('kept punct:', out);
    expect(out).toBe('a big rug, woven by hand.');
});

test('inflectVerb handles regular verbs', () => {
    expect(inflectVerb('show')).toEqual({ '3s': 'shows', past: 'showed', ing: 'showing' });
    expect(inflectVerb('showcase')).toEqual({ '3s': 'showcases', past: 'showcased', ing: 'showcasing' });
    expect(inflectVerb('unleash')).toEqual({ '3s': 'unleashes', past: 'unleashed', ing: 'unleashing' });
    expect(inflectVerb('brag')).toEqual({ '3s': 'brags', past: 'bragged', ing: 'bragging' });
    expect(inflectVerb('carry')).toEqual({ '3s': 'carries', past: 'carried', ing: 'carrying' });
});

test('SourceStr embeds markers on interpolation', () => {
    const k = new SourceStr('tapestry', { file: 'w.json', line: 7, col: 9, path: 'words key' });
    const v = new SourceStr('big rug', { file: 'w.json', line: 7, col: 24, path: 'words["tapestry"]' });
    const line = `  - "${k}" -> "${v}"`;
    console.log('marked:', JSON.stringify(line));
    // strip gives clean text
    expect(stripMarkers(line)).toBe('  - "tapestry" -> "big rug"');
    // parse gives spans
    const spans = parseSpans(line);
    console.log('spans:', spans.map(s => `[${s.source ? s.source.path : 'tpl'}]${s.text}`).join(''));
    expect(spans).toHaveLength(5);
    expect(spans[0]).toEqual({ text: '  - "', source: null });
    expect(spans[1].text).toBe('tapestry');
    expect(spans[1].source?.path).toBe('words key');
    expect(spans[2]).toEqual({ text: '" -> "', source: null });
    expect(spans[3].text).toBe('big rug');
    expect(spans[3].source?.path).toBe('words["tapestry"]');
    expect(spans[4]).toEqual({ text: '"', source: null });
});

test('wrapRawDict produces SourceStr pairs with JSON positions', () => {
    const json = '{\n    "words": {\n        "seam": "whatchamacallit"\n    }\n}';
    const dict = { seam: 'whatchamacallit' };
    const wrapped = wrapRawDict(dict, 'test.json', json, 'words');
    expect(wrapped).toHaveLength(1);
    const [k, vs] = wrapped[0];
    expect(k.valueOf()).toBe('seam');
    expect(vs).toHaveLength(1);
    expect((vs[0] as SourceStr).valueOf()).toBe('whatchamacallit');
    expect(k.meta.line).toBe(3);
    expect((vs[0] as SourceStr).meta.line).toBe(3);
});

test('wrapRawDict handles array values with per-element markers', () => {
    const json = '{\n    "words": {\n        "multi": [\n            "alpha",\n            "beta"\n        ]\n    }\n}';
    const dict = { multi: ['alpha', 'beta'] };
    const wrapped = wrapRawDict(dict, 'test.json', json, 'words');
    expect(wrapped).toHaveLength(1);
    const [, vs] = wrapped[0];
    // values is an array of SourceStr, not a pre-joined string
    expect(vs).toHaveLength(2);
    expect((vs[0] as SourceStr).valueOf()).toBe('alpha');
    expect((vs[0] as SourceStr).meta.path).toBe('words["multi"][0]');
    expect((vs[1] as SourceStr).valueOf()).toBe('beta');
    expect((vs[1] as SourceStr).meta.path).toBe('words["multi"][1]');
});

test('buildPatternSwaps creates regex capture group swaps', () => {
    const pSwaps = buildPatternSwaps({ '(\\w+)-adjacent': '$1-ish-but-not' });
    expect(pSwaps).toHaveLength(1);
    const input = 'rate-adjacent path';
    const out = applySwaps(input, [], pSwaps);
    console.log('in: ', input);
    console.log('out:', out);
    expect(out).toBe('rate-ish-but-not path');
});

test('pattern swaps carry case onto replacement', () => {
    const pSwaps = buildPatternSwaps({ '(\\w+)-shaped': '$1-flavoured jelly' });
    const input = 'A CLOUD-SHAPED object and a star-shaped one';
    const out = applySwaps(input, [], pSwaps);
    console.log('in: ', input);
    console.log('out:', out);
    expect(out).toContain('CLOUD-FLAVOURED JELLY');
    expect(out).toContain('star-flavoured jelly');
});
