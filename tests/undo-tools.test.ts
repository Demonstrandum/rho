// the two extensions driven through fakes standing in for pi: the guard sees a
// real file on disk, and the journal puts a real one back.

import { test, expect, afterAll, beforeAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { config } from '../extensions/lib/config';
import { LOCAL_BACKUPS } from '../extensions/lib/file-store';
import { PersistedState } from '../extensions/lib/state-store';
import installRemove from '../extensions/remove';
import installUndo from '../extensions/undo';

type Handler = (event: unknown, ctx: unknown) => unknown;

const handlers = new Map<string, Handler[]>();
const tools = new Map<string, ToolDefinition<never>>();
const dir = mkdtempSync(join(tmpdir(), 'rho-undo-tools-'));
const session = `undo-tools-${process.pid}`;
const ctx = { cwd: dir, sessionManager: { getSessionId: () => session } };

/** the text a tool_result handler patched, when one did. */
const patched = (results: readonly unknown[]): string | null => {
    for (const result of results) {
        const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
        if (content === undefined) continue;
        return content.map((block) => block.text ?? '').join('\n');
    }
    return null;
};

const fire = async (event: string, payload: unknown): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) out.push(await handler(payload, ctx));
    return out;
};

const call = async (name: string, params: unknown): Promise<string> => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    const execute = tool.execute as unknown as (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
    const result = await execute(
        'call-1',
        params,
        undefined,
        undefined,
        ctx,
    );
    return result.content.map((block) => block.text).join('\n');
};

beforeAll(async () => {
    // the trash is the machine's own, and a test does not put things in the
    // person's trash to find out whether it can.
    (config.files as { removeTo: 'trash' | 'delete' }).removeTo = 'delete';
    const pi = {
        on: (event: string, handler: Handler) => {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        registerTool: (tool: ToolDefinition<never>) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI;
    installRemove(pi);
    installUndo(pi);
    await fire('session_start', {});
});

afterAll(() => {
    // the journal and its copies live in rho's own data directory, which is
    // the person's, not the test's.
    PersistedState.open({ name: 'undo', scope: 'session', parse: () => null }, { cwd: dir, sessionId: session }).clear();
    rmSync(join(LOCAL_BACKUPS, session), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
});

test('write over a file holding bytes is blocked, and says how to proceed', async () => {
    const path = join(dir, 'held.txt');
    writeFileSync(path, 'the line somebody added\n');
    const results = await fire('tool_call', {
        toolName: 'write',
        toolCallId: 'w1',
        input: { path, content: 'replacement\n' },
    });
    const blocked = results.find((result) => (result as { block?: boolean } | undefined)?.block === true) as
        | { block: true; reason: string }
        | undefined;
    expect(blocked).toBeDefined();
    expect(blocked!.reason).toContain('remove');
    expect(readFileSync(path, 'utf8')).toBe('the line somebody added\n');
});

test('write to a new file is not blocked, and undo takes it back', async () => {
    const path = join(dir, 'fresh.txt');
    const results = await fire('tool_call', { toolName: 'write', toolCallId: 'w2', input: { path, content: 'made\n' } });
    expect(results.every((result) => result === undefined)).toBe(true);

    writeFileSync(path, 'made\n');
    await fire('tool_result', { toolName: 'write', toolCallId: 'w2', input: { path }, isError: false });

    expect(await call('undo', { action: 'undo' })).toContain('restored');
    expect(existsSync(path)).toBe(false);
});

test('an edit is journalled, and undo puts the previous bytes back', async () => {
    const path = join(dir, 'edited.txt');
    writeFileSync(path, 'before\n');
    await fire('tool_call', { toolName: 'edit', toolCallId: 'e1', input: { path, edits: [] } });
    writeFileSync(path, 'after\n');
    await fire('tool_result', { toolName: 'edit', toolCallId: 'e1', input: { path }, isError: false });

    expect(await call('undo', { action: 'list' })).toContain('edit');
    expect(await call('undo', { action: 'undo', path })).toContain('restored');
    expect(readFileSync(path, 'utf8')).toBe('before\n');
});

test('the mutation is numbered in the result of the call that made it, and that number undoes it', async () => {
    const first = join(dir, 'one.txt');
    const second = join(dir, 'two.txt');
    writeFileSync(first, 'first was here\n');
    writeFileSync(second, 'second was here\n');

    await fire('tool_call', { toolName: 'edit', toolCallId: 'n1', input: { path: first, edits: [] } });
    writeFileSync(first, 'first changed\n');
    const said = patched(
        await fire('tool_result', {
            toolName: 'edit',
            toolCallId: 'n1',
            input: { path: first },
            isError: false,
            content: [{ type: 'text', text: 'Edited one.txt' }],
        }),
    );
    expect(said).toContain('Edited one.txt');
    const id = Number(/undo (\d+)/.exec(said ?? '')?.[1]);
    expect(Number.isInteger(id)).toBe(true);

    // a later mutation of another file, so 'the most recent' is not the answer.
    await fire('tool_call', { toolName: 'edit', toolCallId: 'n2', input: { path: second, edits: [] } });
    writeFileSync(second, 'second changed\n');
    await fire('tool_result', { toolName: 'edit', toolCallId: 'n2', input: { path: second }, isError: false });

    expect(await call('undo', { action: 'undo', id })).toContain('restored');
    expect(readFileSync(first, 'utf8')).toBe('first was here\n');
    expect(readFileSync(second, 'utf8')).toBe('second changed\n');
});

test('a number that names nothing is reported rather than taken as the most recent', async () => {
    expect(await call('undo', { action: 'undo', id: 9999 })).toContain('nothing recorded under 9999');
});

test('a file changed after the mutation is reported rather than overwritten', async () => {
    const path = join(dir, 'moved-on.txt');
    writeFileSync(path, 'one\n');
    await fire('tool_call', { toolName: 'write', toolCallId: 'w3', input: { path, content: 'two\n' } });
    writeFileSync(path, 'two\n');
    await fire('tool_result', { toolName: 'write', toolCallId: 'w3', input: { path }, isError: false });

    writeFileSync(path, 'three\n');
    const said = await call('undo', { action: 'undo', path });
    expect(said).toContain('not restored');
    expect(readFileSync(path, 'utf8')).toBe('three\n');
});

test('remove takes a file away and undo brings it back', async () => {
    const path = join(dir, 'doomed.txt');
    writeFileSync(path, 'contents\n');
    expect(await call('remove', { path })).toContain('removed');
    expect(existsSync(path)).toBe(false);

    expect(await call('undo', { action: 'undo', path })).toContain('restored');
    expect(readFileSync(path, 'utf8')).toBe('contents\n');
});

test('a write that fails records nothing', async () => {
    const path = join(dir, 'failed.txt');
    writeFileSync(path, 'untouched\n');
    await fire('tool_call', { toolName: 'edit', toolCallId: 'e2', input: { path, edits: [] } });
    await fire('tool_result', { toolName: 'edit', toolCallId: 'e2', input: { path }, isError: true });

    const listed = await call('undo', { action: 'list' });
    expect(listed).not.toContain('failed.txt');
});
