import { expect, test } from 'bun:test';
import { plain } from '../extensions/lib/text';
import { callPreview, resultPreview, summariseArgs } from '../extensions/lib/tool-row/preview';
import { retitle, toolTitle } from '../extensions/lib/tool-row/title';

test('toolTitle drops a namespace and spaces the words, lower case throughout', () => {
    expect(toolTitle('slack_reply')).toBe('slack reply');
    expect(toolTitle('web_search')).toBe('web search');
    expect(toolTitle('read')).toBe('read');
    expect(toolTitle('ctx_search')).toBe('search');
    expect(toolTitle('mcp__brave__web_search')).toBe('brave web search');
    expect(toolTitle('fetchContent')).toBe('fetch content');
    // a namespace on its own is the name, not a prefix to drop.
    expect(toolTitle('ctx')).toBe('ctx');
});

test('toolTitle takes the exec family from the names the preview already uses', () => {
    expect(toolTitle('ctx_execute')).toBe('exec');
    expect(toolTitle('ctx_execute_file')).toBe('exec file');
    expect(toolTitle('ctx_batch_execute')).toBe('batch');
});

test('toolTitle takes an override ahead of the derivation', () => {
    expect(toolTitle('slack_reply', { slack_reply: 'say' })).toBe('say');
});

test('retitle replaces the leading name and keeps its styling', () => {
    const line = '\x1b[1mslack_reply\x1b[22m D0C0';
    expect(retitle(line, 'slack_reply', 'slack reply')).toBe('\x1b[1mslack reply\x1b[22m D0C0');
});

test('retitle leaves a line whose head is something else', () => {
    expect(retitle('exec `ls`', 'ctx_execute', 'exec')).toBe('exec `ls`');
    // the name appears, but as the argument rather than the head.
    expect(retitle('read slack_reply.ts', 'slack_reply', 'slack reply')).toBe('read slack_reply.ts');
    // a longer title that would overflow the row is declined.
    expect(retitle('ls x', 'ls', 'list files', 8)).toBe('ls x');
});

test('summariseArgs picks a subject, the text, and the rest', () => {
    const summary = summariseArgs({ channel: 'D0C0', text: "Hey Adam, it's done", thread: '1.2' });
    expect(summary.subject).toEqual({ key: 'channel', value: 'D0C0' });
    expect(summary.body).toBe("Hey Adam, it's done");
    expect(summary.rest).toEqual([{ key: 'thread', value: '1.2' }]);
});

test('callPreview names the subject and quotes the first line', () => {
    const lines = callPreview({
        title: 'slack reply',
        args: { channel: 'D0C0PG7LZCJ', text: 'Hey Adam, the build is green\nand the tests pass' },
        note: 'Adam',
        expanded: false,
        width: 80,
    }).map(plain);
    expect(lines[0]).toBe('slack reply to Adam');
    expect(lines[1]).toBe('> Hey Adam, the build is green \u2026');
    expect(lines).toHaveLength(2);
});

test('callPreview expanded gives every line and the remaining arguments', () => {
    const lines = callPreview({
        title: 'slack reply',
        args: { channel: 'D0C0', text: 'one\ntwo', thread: '1.2' },
        expanded: true,
        width: 80,
    }).map(plain);
    expect(lines).toEqual(['slack reply to D0C0', '> one', '> two', 'thread: 1.2']);
});

test('callPreview falls back to the arguments when nothing names the call', () => {
    const [line] = callPreview({ title: 'batch', args: { concurrency: 4 }, expanded: false, width: 80 }).map(plain);
    expect(line).toBe('batch concurrency=4');
});

test('a name takes the place of the identifier it stands for', () => {
    const args = { channel: 'D0C0PG7LZCJ', text: 'done' };
    const [collapsed] = callPreview({ title: 'slack reply', args, note: 'Adam', expanded: false, width: 80 }).map(plain);
    expect(collapsed).toBe('slack reply to Adam');
    // the identifier is what the row is about, so expanding gives it back.
    const [expanded] = callPreview({ title: 'slack reply', args, note: 'Adam', expanded: true, width: 80 }).map(plain);
    expect(expanded).toBe('slack reply to Adam (D0C0PG7LZCJ)');
});

test('a result that only repeats the call is dropped', () => {
    const args = { channel: 'D0C0PG7LZCJ', text: 'done' };
    expect(resultPreview({ text: 'Sent to D0C0PG7LZCJ.', args, expanded: false, width: 80 })).toEqual([]);
    expect(resultPreview({ text: 'Sent to Adam.', args, note: 'Adam', expanded: false, width: 80 })).toEqual([]);
});

test('a result that says something the call did not is kept', () => {
    const args = { channel: 'D0C0PG7LZCJ', text: 'done' };
    const kept = resultPreview({ text: 'Slack refused it: rate limited', args, expanded: false, width: 80 }).map(plain);
    expect(kept).toEqual(['Slack refused it: rate limited']);
    // expanding gives the text as the tool wrote it.
    expect(resultPreview({ text: 'Sent to D0C0PG7LZCJ.', args, expanded: true, width: 80 }).map(plain))
        .toEqual(['Sent to D0C0PG7LZCJ.']);
});
