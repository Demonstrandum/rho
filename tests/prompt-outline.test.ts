import { test, expect } from 'bun:test';
import { outline, pretty, raw, systemText, weight } from '../extensions/prompt-inspect/outline';
import { RequestLog } from '../extensions/prompt-inspect/log';

const PAYLOAD = {
    model: 'claude-opus-5',
    system: 'line one\nline two',
    messages: [
        { role: 'user', content: 'hello' },
        {
            role: 'assistant',
            content: [
                { type: 'thinking', thinking: 'a\nb' },
                { type: 'text', text: 'hi' },
            ],
        },
    ],
    tools: [{ name: 'bash', input_schema: { type: 'object' } }],
};

test('every property and array element becomes a node, parents first', () => {
    const nodes = outline(PAYLOAD);
    const paths = nodes.map((node) => node.path);
    expect(paths.slice(0, 4)).toEqual(['model', 'system', 'messages', 'messages[0]']);
    expect(paths).toContain('messages[1].content[0]');
    expect(paths).toContain('tools[0].input_schema');
});

test('an array element is labelled by the role, type, or name it carries', () => {
    const labels = new Map(outline(PAYLOAD).map((node) => [node.path, node.label]));
    expect(labels.get('messages[0]')).toBe('message 0  user');
    expect(labels.get('messages[1].content[0]')).toBe('content 0  thinking');
    expect(labels.get('tools[0]')).toBe('tool 0  bash');
});

test('the walk stops at the configured depth and leaves the subtree whole', () => {
    const shallow = outline(PAYLOAD, { maxDepth: 1 });
    expect(shallow.some((node) => node.path === 'messages[0]')).toBe(true);
    expect(shallow.some((node) => node.path === 'messages[0].role')).toBe(false);
});

test('pretty prints a string over its own newlines, raw escapes them', () => {
    expect(pretty(PAYLOAD.system)).toEqual(['line one', 'line two']);
    expect(raw(PAYLOAD.system)).toEqual(['"line one\\nline two"']);
    expect(pretty({ role: 'user', content: 'hello' })).toEqual(['role: user', 'content: hello']);
});

test('weight counts the characters under a subtree', () => {
    expect(weight('hello')).toBe(5);
    expect(weight(['ab', 'c'])).toBe(3);
});

test('the log keeps its capacity and never reuses an ordinal', () => {
    const log = new RequestLog(2);
    log.record({ n: 1 }, 'anthropic/opus');
    log.record({ n: 2 }, 'anthropic/opus');
    log.record({ n: 3 }, 'anthropic/opus');
    expect(log.size).toBe(2);
    expect(log.list().map((entry) => entry.ordinal)).toEqual([2, 3]);
    expect(log.byOrdinal(1)).toBeUndefined();
    expect(log.latest()?.payload).toEqual({ n: 3 });
    expect(log.clear()).toBe(2);
    expect(log.record({ n: 4 }, null).ordinal).toBe(4);
});

test('the system text comes out of wherever the provider put it', () => {
    expect(systemText({ system: 'one\ntwo' })).toBe('one\ntwo');
    expect(systemText({ system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    expect(systemText({ systemInstruction: { parts: [{ text: 'g' }] } })).toBe('g');
    expect(systemText({ messages: [{ role: 'developer', content: 'd' }, { role: 'user', content: 'u' }] })).toBe('d');
    expect(systemText({ messages: [{ role: 'user', content: 'u' }] })).toBeNull();
    expect(systemText('not a payload')).toBeNull();
});
