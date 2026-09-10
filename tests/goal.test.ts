import { test, expect } from 'bun:test';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
    classifyFailure,
    directiveText,
    feedbackText,
    parseActiveGoal,
    renderTranscript,
} from '../extensions/lib/goal';

function userEntry(id: string, text: string): SessionEntry {
    return {
        type: 'message',
        id,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'user', content: text, timestamp: 0 },
    };
}

function assistantEntry(id: string, text: string): SessionEntry {
    return {
        type: 'message',
        id,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'test',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: 0,
        },
    };
}

test('a transcript within budget keeps every entry and tags the roles', () => {
    const rendered = renderTranscript([userEntry('a', 'migrate the module'), assistantEntry('b', 'tests pass')], 10_000);
    expect(rendered).toContain('<user>\nmigrate the module\n</user>');
    expect(rendered).toContain('<agent>\ntests pass\n</agent>');
    expect(rendered).not.toContain('omitted');
});

test('an over-budget transcript drops oldest entries and says so', () => {
    const entries = Array.from({ length: 20 }, (_, i) => userEntry(`e${i}`, `entry ${i} `.repeat(20)));
    const rendered = renderTranscript(entries, 400);

    expect(rendered).toContain('insufficient evidence in transcript');
    expect(rendered).toContain('entry 19');
    expect(rendered).not.toContain('entry 0 ');
});

test('a single entry over budget is still sent, since a transcript of nothing judges nothing', () => {
    const rendered = renderTranscript([userEntry('a', 'x'.repeat(500))], 10);
    expect(rendered).toContain('xxx');
});

test('a thinking block never reaches the judge', () => {
    const entry = assistantEntry('a', 'done');
    const message = (entry as { message: { content: unknown[] } }).message;
    message.content = [{ type: 'thinking', thinking: 'I think it compiles' }, { type: 'text', text: 'done' }];

    const rendered = renderTranscript([entry], 10_000);
    expect(rendered).toContain('done');
    expect(rendered).not.toContain('I think it compiles');
});

test('a tool call is rendered by name and arguments', () => {
    const entry = assistantEntry('a', 'running');
    const message = (entry as { message: { content: unknown[] } }).message;
    message.content = [{ type: 'toolCall', id: '1', name: 'bash', arguments: { command: 'npm test' } }];

    expect(renderTranscript([entry], 10_000)).toContain('[calls bash {"command":"npm test"}]');
});

test('only the failures a human has to fix are fatal', () => {
    expect(classifyFailure('401 Unauthorized')).toBe('an authentication failure');
    expect(classifyFailure('your credit balance is too low')).toBe('an exhausted balance');
    expect(classifyFailure('prompt is too long: 300000 tokens')).toBe('a context overflow');
    expect(classifyFailure('model not found: claude-opus-9')).toBe('an unavailable model');

    expect(classifyFailure('429 rate limited, please retry')).toBeNull();
    expect(classifyFailure('overloaded_error')).toBeNull();
    expect(classifyFailure(undefined)).toBeNull();
});

test('stored goal state is validated rather than cast', () => {
    const goal = { condition: 'tests pass', setAt: 1, iterations: 2, blocks: 1, lastReason: 'two failing' };
    expect(parseActiveGoal(goal)).toEqual(goal);

    expect(parseActiveGoal(null)).toBeNull();
    expect(parseActiveGoal({ condition: '   ', setAt: 1, iterations: 0, blocks: 0 })).toBeNull();
    expect(parseActiveGoal({ condition: 'x', setAt: 'now', iterations: 0, blocks: 0 })).toBeNull();
    expect(parseActiveGoal({ condition: 'x', setAt: 1, iterations: 1.5, blocks: 0 })).toBeNull();
    expect(parseActiveGoal({ condition: 'x', setAt: 1, iterations: 0, blocks: 0, lastReason: 3 })).toBeNull();
});

test('the directive and the feedback both carry the condition', () => {
    expect(directiveText('lint is clean')).toContain('"lint is clean"');

    const feedback = feedbackText('lint is clean', 'three files still fail');
    expect(feedback).toContain('lint is clean');
    expect(feedback).toContain('three files still fail');
});
