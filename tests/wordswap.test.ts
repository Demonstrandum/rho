import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSwaps, applySwaps, promptNote } from '../extensions/wordswap';

const dict = { 'load-bearing': 'cooked', 'honest take': 'spicy doodad', seam: 'whatchamacallit' };

test('buildSwaps yields one case-insensitive, word-bounded rule per entry', () => {
    const swaps = buildSwaps(dict);
    console.log('rules:', swaps.map((s) => `${s.original}->${s.replacement}`).join(', '));
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
    ) as Record<string, string>;
    const swaps = buildSwaps(shipped);
    expect(swaps.length).toBeGreaterThan(0);
    console.log(promptNote(swaps));
    expect(promptNote(swaps)).toContain('## vocabulary');
});
