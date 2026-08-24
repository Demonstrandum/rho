import { test, expect } from 'bun:test';
import { mergeThinkingRuns, type ContentBlock } from '../extensions/merge-thinking-blocks';

function thinking(text: string, signature: string): ContentBlock {
    return { type: 'thinking', thinking: text, signature };
}

test('a single thinking block is left alone', () => {
    const blocks: ContentBlock[] = [thinking('one', 'sig1'), { type: 'tool_use' }];
    expect(mergeThinkingRuns(blocks)).toBeNull();
});

test('a run of thinking blocks becomes one block with the last signature', () => {
    const merged = mergeThinkingRuns([
        thinking('first. ', 'sig1'),
        thinking('second.', 'sig2'),
        { type: 'tool_use' },
    ]);
    expect(merged).toEqual([
        { type: 'thinking', thinking: 'first. second.', signature: 'sig2' },
        { type: 'tool_use' },
    ]);
});

test('thinking blocks split by another block stay separate', () => {
    const blocks: ContentBlock[] = [thinking('a', 'sig1'), { type: 'text' }, thinking('b', 'sig2')];
    expect(mergeThinkingRuns(blocks)).toBeNull();
});

test('two runs each collapse to one block', () => {
    const merged = mergeThinkingRuns([
        thinking('a', 'sig1'),
        thinking('b', 'sig2'),
        { type: 'text' },
        thinking('c', 'sig3'),
        thinking('d', 'sig4'),
    ]);
    expect(merged).toEqual([
        { type: 'thinking', thinking: 'ab', signature: 'sig2' },
        { type: 'text' },
        { type: 'thinking', thinking: 'cd', signature: 'sig4' },
    ]);
});

test('a block missing its signature is not treated as a thinking block', () => {
    const blocks: ContentBlock[] = [
        { type: 'thinking' },
        thinking('real', 'sig1'),
    ];
    expect(mergeThinkingRuns(blocks)).toBeNull();
});
