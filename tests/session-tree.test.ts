// the patch, driven through fakes standing in for the parts of
// InteractiveMode it reaches. this is what catches a pi release that renames a
// private the view reads: the names are exercised here rather than at a
// keystroke in a live session.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { InteractiveMode, initTheme, type ExtensionAPI, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plain } from '../extensions/lib/text';
import install from '../extensions/session-tree';

const at = (n: number) => new Date(1760000000000 + n * 1000).toISOString();

function user(id: string, parentId: string | null, text: string, n: number): SessionEntry {
    return {
        type: 'message',
        id,
        parentId,
        timestamp: at(n),
        message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
    };
}

function assistant(id: string, parentId: string, text: string, n: number): SessionEntry {
    return {
        type: 'message',
        id,
        parentId,
        timestamp: at(n),
        message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'claude',
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            timestamp: 0,
        },
    } as SessionEntry;
}

function entries(): SessionEntry[] {
    return [
        user('u1', null, 'first prompt', 0),
        assistant('a1', 'u1', 'first reply', 1),
        user('u2', 'a1', 'second prompt', 2),
        assistant('a2', 'u2', 'second reply', 3),
        user('u3', 'a2', 'third prompt', 4),
        assistant('a3', 'u3', 'third reply', 5),
        user('u4', 'a2', 'other branch', 6),
        assistant('a4', 'u4', 'other reply', 7),
    ];
}

interface Opened {
    key(data: string): void;
    lines(): string[];
    status: string[];
    errors: string[];
    selectorCount: number;
    /** answers handed to the dialogs, in order. */
    answers: string[];
    switched: string[];
    navigated: string[];
    sessionDir: string;
}

/** an InteractiveMode-shaped object holding only what the view touches. */
function fakeMode(state: { entries: SessionEntry[]; leaf: string | null }, opened: Opened) {
    return {
        sessionManager: {
            getEntries: () => state.entries,
            getLeafId: () => state.leaf,
            getSessionFile: () => `${opened.sessionDir}/session.jsonl`,
            getSessionDir: () => opened.sessionDir,
            getCwd: () => '/tmp',
        },
        ui: { terminal: { rows: 40 }, requestRender: () => {} },
        settingsManager: { getTreeFilterMode: () => 'default' as const },
        runtimeHost: {
            switchSession: async (path: string) => {
                opened.switched.push(path);
                return { cancelled: false };
            },
        },
        session: {
            navigateTree: async (target: string) => {
                opened.navigated.push(target);
                return { cancelled: false };
            },
        },
        chatContainer: { clear: () => {} },
        editor: { getText: () => '', setText: () => {} },
        renderInitialMessages: () => {},
        showSelector(create: (done: () => void) => { component: { render(width: number): string[] } }) {
            opened.selectorCount += 1;
            const handle = create(() => {});
            const component = handle.component as unknown as {
                render(width: number): string[];
                handleInput(data: string): void;
            };
            opened.key = (data: string) => component.handleInput(data);
            opened.lines = () => component.render(80);
        },
        showStatus: (message: string) => opened.status.push(message),
        showError: (message: string) => opened.errors.push(message),
        showExtensionSelector: async () => opened.answers.shift(),
        showExtensionEditor: async () => opened.answers.shift(),
        showTreeSelector(_id?: string) {},
    };
}

function openTree(state: { entries: SessionEntry[]; leaf: string | null }, startAt?: string): Opened {
    const opened: Opened = {
        key: () => {},
        lines: () => [],
        status: [],
        errors: [],
        selectorCount: 0,
        answers: [],
        switched: [],
        navigated: [],
        sessionDir: mkdtempSync(join(tmpdir(), 'rho-session-tree-')),
    };
    const mode = fakeMode(state, opened);
    const patchedOpen = (InteractiveMode.prototype as unknown as { showTreeSelector(id?: string): void })
        .showTreeSelector;
    mode.showTreeSelector = (id?: string) => patchedOpen.call(mode as never, id);
    mode.showTreeSelector(startAt);
    return opened;
}

const registered: string[] = [];
let started: ((event: unknown, ctx: unknown) => void) | undefined;

// pi's components draw through a theme held under a global symbol. it is put
// back afterwards: a live theme left behind changes what other tests in this
// process see, since anything laid over a theme resolves through that symbol.
const LIVE_THEME = Symbol.for('@earendil-works/pi-coding-agent:theme');
const themeBefore = (globalThis as Record<symbol, unknown>)[LIVE_THEME];

afterAll(() => {
    if (themeBefore === undefined) delete (globalThis as Record<symbol, unknown>)[LIVE_THEME];
    else (globalThis as Record<symbol, unknown>)[LIVE_THEME] = themeBefore;
});

beforeAll(() => {
    initTheme();
    const pi = {
        on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
            if (event === 'session_start') started = handler;
        },
        registerShortcut: (name: string) => registered.push(name),
        registerCommand: (name: string) => registered.push(`/${name}`),
    } as unknown as ExtensionAPI;
    install(pi);
});

/** a context whose summariser answers with fixed text, and records its input. */
function fakeContext(seen: string[]) {
    return {
        model: { id: 'claude', provider: 'anthropic', api: 'anthropic-messages' },
        modelRegistry: {
            complete: async (_model: unknown, request: { messages: { content: { text: string }[] }[] }) => {
                seen.push(request.messages[0]!.content[0]!.text);
                return {
                    content: [{ type: 'text', text: 'the span, summarised' }],
                    stopReason: 'stop',
                };
            },
        },
    };
}

test('the patch takes over the tree and registers the session copies', () => {
    // shift+ctrl+t is pi's own binding for app.session.tree, which the patch
    // already covers; registering it here would take it off pi's action.
    expect(registered).not.toContain('shift+ctrl+t');
    expect(registered).toContain('/session-copy');
    expect(registered).toContain('/session-backup');
});

test('the view opens on the session and draws a row per entry', () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' });
    expect(opened.errors).toEqual([]);
    const text = opened.lines().map(plain).join('\n');
    expect(text).toContain('first prompt');
    expect(text).toContain('other branch');
    expect(text).toContain('j/k move');
});

test('the cursor gutter, the numbers, and the branch point they stop at', () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'a1');
    const rows = opened
        .lines()
        .map(plain)
        .filter((line) => /prompt|reply|branch/.test(line));
    const cursor = rows.find((line) => line.startsWith('\u203a'));
    expect(cursor).toContain('first reply');
    // the row above the cursor is one away, and numbered
    expect(rows.some((line) => line.startsWith(' 1') && line.includes('first prompt'))).toBe(true);
    // a2 branches, so rows past it carry no number
    expect(rows.find((line) => line.includes('other branch'))?.startsWith('  ')).toBe(true);
});

test('shift extends a selection along the branch and escape drops it', () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'a1');
    opened.key('J');
    const band = () =>
        opened
            .lines()
            .map(plain)
            .filter((line) => line.startsWith('\u2503'));
    expect(band().length).toBe(1);
    expect(band()[0]).toContain('first reply');

    opened.key('\x1b');
    expect(band().length).toBe(0);
});

test('a selection cannot be dragged across a branch point', () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'a2');
    opened.key('v');
    opened.key('9');
    opened.key('J');
    expect(
        opened
            .lines()
            .map(plain)
            .filter((line) => line.startsWith('\u2503')).length,
    ).toBeLessThanOrEqual(2);
});

test('deleting a run edits the buffer and reopens the view', async () => {
    const state = { entries: entries(), leaf: 'a3' };
    const opened = openTree(state, 'u2');
    opened.key('d');
    await Bun.sleep(5);
    // the dialog answers undefined (cancelled), so the view is put back and
    // the session file is untouched either way
    expect(opened.selectorCount).toBeGreaterThan(1);
    expect(opened.errors).toEqual([]);
});

test('undo with nothing to undo says so rather than throwing', () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' });
    opened.key('u');
    expect(opened.status).toContain('Nothing to undo');
});

test('search mode hands its keys to pi and leaves on escape', () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' });
    opened.key('/');
    expect(opened.lines().map(plain).join('\n')).toContain('type filter');
    opened.key('o');
    opened.key('t');
    expect(opened.lines().map(plain).join('\n')).toContain('ot');
    opened.key('\x1b');
    expect(opened.lines().map(plain).join('\n')).toContain('j/k move');
});

test('a delete answered in the dialog changes the buffer and is shown as pending', async () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'u2');
    opened.answers.push('Keep what follows');
    opened.key('d');
    await Bun.sleep(10);
    const text = opened.lines().map(plain).join('\n');
    expect(text).not.toContain('second prompt');
    expect(text).toContain('third prompt');
    expect(text).toContain('1 edit pending');
    expect(opened.switched).toEqual([]);
});

test('committing writes every branch to a new file and switches to it', async () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'u3');
    opened.answers.push('Delete what follows too');
    opened.key('d');
    await Bun.sleep(10);
    opened.key('\r');
    await Bun.sleep(10);

    expect(opened.switched.length).toBe(1);
    const written = opened.switched[0]!;
    expect(readdirSync(opened.sessionDir)).toContain(written.split('/').pop()!);
    const lines = readFileSync(written, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const header = lines[0] as { type: string; parentSession?: string };
    expect(header.type).toBe('session');
    expect(header.parentSession).toBe(join(opened.sessionDir, 'session.jsonl'));
    const ids = lines.slice(1).map((entry: { id: string }) => entry.id);
    // the deleted subtree is gone, the branch beside it is still there
    expect(ids).toEqual(['u1', 'a1', 'u2', 'a2', 'u4', 'a4']);
});

test('summarising a selected span replaces it with what the model returned', async () => {
    const seen: string[] = [];
    started?.({}, fakeContext(seen));
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'u2');
    opened.answers.push('');
    opened.key('v');
    opened.key('J');
    opened.key('s');
    await Bun.sleep(20);

    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('user: second prompt');
    expect(seen[0]).toContain('assistant: second reply');
    expect(seen[0]).not.toContain('third prompt');

    const text = opened.lines().map(plain).join('\n');
    expect(text).toContain('the span, summarised');
    expect(text).not.toContain('second prompt');
    expect(text).toContain('third prompt');
    expect(text).toContain('1 edit pending');
});

test('after a delete the cursor sits where the span was, and the commit navigates there', async () => {
    const seen: string[] = [];
    started?.({}, fakeContext(seen));
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'u3');
    opened.answers.push('Delete what follows too');
    opened.key('d');
    await Bun.sleep(10);
    opened.key('\r');
    await Bun.sleep(10);
    expect(opened.switched.length).toBe(1);
    expect(opened.navigated).toEqual(['a2']);
});

test('every private of pi the patch reaches is still there', () => {
    const entry = Bun.resolveSync('@earendil-works/pi-coding-agent', import.meta.dir);
    const dist = entry.slice(0, entry.lastIndexOf('/dist/') + '/dist/'.length);
    const mode = readFileSync(`${dist}modes/interactive/interactive-mode.js`, 'utf8');
    const tree = readFileSync(`${dist}modes/interactive/components/tree-selector.js`, 'utf8');

    for (const member of [
        'showTreeSelector(',
        'showSelector(',
        'showStatus(',
        'showError(',
        'showExtensionSelector(',
        'showExtensionEditor(',
        'renderInitialMessages(',
        'this.chatContainer',
        'this.runtimeHost.switchSession',
        'this.settingsManager.getTreeFilterMode',
        'this.ui.terminal.rows',
        'this.session.navigateTree',
    ]) {
        expect(mode).toContain(member);
    }
    for (const member of [
        'filteredNodes',
        'selectedIndex',
        'maxVisibleLines',
        'visibleParentMap',
        'visibleChildrenMap',
        'copySelected',
        'labelInput',
        'getTreeList',
    ]) {
        expect(tree).toContain(member);
    }
});

test('a clean tree still navigates, through the branch-summary prompt', async () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'u2');
    opened.answers.push('No summary');
    opened.key('\r');
    await Bun.sleep(10);
    expect(opened.errors).toEqual([]);
    expect(opened.navigated).toEqual(['u2']);
    expect(opened.switched).toEqual([]);
});

test('an unshifted move drops the selection, v holds it through one', () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'a1');
    const band = () =>
        opened
            .lines()
            .map(plain)
            .filter((line) => line.startsWith('\u2503')).length;

    opened.key('\x1b[1;2B');
    expect(band()).toBe(1);
    opened.key('j');
    expect(band()).toBe(0);

    opened.key('v');
    opened.key('j');
    expect(band()).toBeGreaterThan(0);
});

test('a digit typed with shift down still counts', () => {
    const opened = openTree({ entries: entries(), leaf: 'a3' }, 'u1');
    opened.key('#');
    opened.key('\x1b[1;2B');
    expect(
        opened
            .lines()
            .map(plain)
            .filter((line) => line.startsWith('\u2503')).length,
    ).toBe(3);
});
