// a session made up to be looked at: every entry kind pi renders, a tree with
// two branch points in it, and enough text that the transcript, the tree view
// and the pickers all have something to show.
//
// it exists because the things that draw a session are hard to work on without
// one. a fresh session has nothing in it, and a real one is somebody's work,
// with their paths and their mistakes in it, which cannot be shipped, put in a
// screenshot, or replayed on another machine. this builds the same shapes from
// nothing: the entries are the ones in docs/session-format.md, so a renderer
// that handles these handles a real file.
//
// it is modelled on a real session of rho's own (a rewrite of a shell helper),
// and it is deterministic: the ids are fixed and the timestamps count from a
// fixed start, so two runs produce identical files and a test can name an
// entry.

import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';

/**
 * an entry without the three fields the builder attaches.
 *
 * `Omit` over a union collapses it to the members they share, which is
 * nothing, so the omission is distributed over the union instead.
 */
type Unkeyed<T> = T extends unknown ? Omit<T, 'id' | 'parentId' | 'timestamp'> : never;
type DraftEntry = Unkeyed<SessionEntry>;

/** where the made-up clock starts: 2026-01-05T09:00:00Z. */
const START = Date.UTC(2026, 0, 5, 9, 0, 0);

const MODEL = { provider: 'anthropic', modelId: 'claude-opus-5' } as const;

function usage(input: number, output: number): Usage {
    const cost = {
        input: input * 0.000015,
        output: output * 0.000075,
        cacheRead: 0,
        cacheWrite: 0,
        total: input * 0.000015 + output * 0.000075,
    };
    return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost };
}

/**
 * the entries as they are written, before ids and parents are attached.
 *
 * a sample is easier to read and to extend as a list with the branch points
 * named, so the shape here is `[id, parent, entry]` and the builder below does
 * the rest. ids are the eight hex characters pi uses, chosen by hand so an
 * entry can be named in a test.
 */
interface Draft {
    readonly id: string;
    readonly parent: string | null;
    /** seconds after START. */
    readonly at: number;
    readonly entry: DraftEntry;
}

function message(message: AgentMessage): DraftEntry {
    return { type: 'message', message } as DraftEntry;
}

function user(text: string): DraftEntry {
    return message({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 });
}

interface AssistantParts {
    readonly thinking?: string;
    readonly text?: string;
    readonly calls?: readonly { readonly id: string; readonly name: string; readonly arguments: object }[];
    readonly stopReason?: 'stop' | 'toolUse' | 'aborted' | 'error';
    readonly errorMessage?: string;
    readonly tokens?: readonly [number, number];
}

function assistant(parts: AssistantParts): DraftEntry {
    const content = [
        ...(parts.thinking !== undefined ? [{ type: 'thinking' as const, thinking: parts.thinking }] : []),
        ...(parts.text !== undefined ? [{ type: 'text' as const, text: parts.text }] : []),
        ...(parts.calls ?? []).map((call) => ({ type: 'toolCall' as const, ...call })),
    ];
    const [input, output] = parts.tokens ?? [4200, 180];
    return message({
        role: 'assistant',
        content,
        api: 'anthropic-messages',
        provider: MODEL.provider,
        model: MODEL.modelId,
        usage: usage(input, output),
        stopReason: parts.stopReason ?? (parts.calls?.length ? 'toolUse' : 'stop'),
        ...(parts.errorMessage !== undefined && { errorMessage: parts.errorMessage }),
        timestamp: 0,
    } as AgentMessage);
}

function toolResult(
    callId: string,
    name: string,
    text: string,
    isError = false,
): DraftEntry {
    return message({
        role: 'toolResult',
        toolCallId: callId,
        toolName: name,
        content: [{ type: 'text', text }],
        isError,
        timestamp: 0,
    } as AgentMessage);
}

const FLAG_PATCH = `@@ -12,6 +12,11 @@
 const args = process.argv.slice(2);
+if (args.includes('--version')) {
+    console.log(pkg.version);
+    process.exit(0);
+}
 const target = args[0];`;

/**
 * the sample, in file order.
 *
 * the tree it makes:
 *
 *   model/thinking - user "add a --version flag"
 *     - assistant (thinking, bash) - result - assistant (read) - result
 *       - assistant (text) - user "make it print the commit too"
 *         - assistant (edit) - result - assistant (text)      <- the live branch
 *         - branch summary - user "actually, drop the commit" - assistant
 *       - user "what does the test suite say" (a second branch off the same reply)
 *         - assistant (bash) - result (failing) - assistant (aborted)
 */
const DRAFTS: readonly Draft[] = [
    { id: 'a0000000', parent: null, at: 0, entry: { type: 'session_info', name: 'Sample session' } },
    { id: 'a0000001', parent: 'a0000000', at: 0, entry: { type: 'model_change', ...MODEL } },
    { id: 'a0000002', parent: 'a0000001', at: 0, entry: { type: 'thinking_level_change', thinkingLevel: 'medium' } },
    {
        id: 'a0000003',
        parent: 'a0000002',
        at: 4,
        entry: user('add a --version flag to bin/release.ts, and print the version from package.json'),
    },
    {
        id: 'a0000004',
        parent: 'a0000003',
        at: 9,
        entry: assistant({
            thinking:
                'The file is small enough to read whole. I want to see how it parses argv before adding anything, since a flag inserted before the positional handling changes what index 0 means.',
            text: 'Reading the entry point first.',
            calls: [{ id: 'call_01', name: 'bash', arguments: { command: 'wc -l bin/release.ts && head -20 bin/release.ts' } }],
        }),
    },
    {
        id: 'a0000005',
        parent: 'a0000004',
        at: 11,
        entry: toolResult(
            'call_01',
            'bash',
            "41 bin/release.ts\n#!/usr/bin/env bun\nimport pkg from '../package.json';\n\nconst args = process.argv.slice(2);\nconst target = args[0];\n",
        ),
    },
    {
        id: 'a0000006',
        parent: 'a0000005',
        at: 14,
        entry: assistant({
            text: 'The version is already imported, so the flag is four lines.',
            calls: [
                {
                    id: 'call_02',
                    name: 'edit',
                    arguments: { path: 'bin/release.ts', oldText: 'const target = args[0];', newText: FLAG_PATCH },
                },
            ],
            tokens: [5100, 240],
        }),
    },
    { id: 'a0000007', parent: 'a0000006', at: 15, entry: toolResult('call_02', 'edit', 'Edited bin/release.ts') },
    {
        id: 'a0000008',
        parent: 'a0000007',
        at: 18,
        entry: assistant({
            thinking: 'Worth running it once rather than claiming it works.',
            text: '`--version` now prints the version from package.json and exits before the positional argument is read, so `release --version` no longer looks like a target named `--version`.',
            tokens: [5400, 320],
        }),
    },
    { id: 'a0000009', parent: 'a0000008', at: 30, entry: { type: 'label', targetId: 'a0000008', label: 'flag works' } },

    // first branch point: the follow-up that was taken
    { id: 'a000000a', parent: 'a0000009', at: 40, entry: user('make it print the short commit too') },
    {
        id: 'a000000b',
        parent: 'a000000a',
        at: 44,
        entry: assistant({
            text: 'Taking the commit from git rather than from a build-time constant, so a dirty checkout says so.',
            calls: [{ id: 'call_03', name: 'bash', arguments: { command: 'git rev-parse --short HEAD' } }],
        }),
    },
    { id: 'a000000c', parent: 'a000000b', at: 45, entry: toolResult('call_03', 'bash', '9f3c1ad\n') },
    {
        id: 'a000000d',
        parent: 'a000000c',
        at: 52,
        entry: assistant({
            text: 'It prints `0.4.1 (9f3c1ad)`, and `(9f3c1ad, dirty)` when the tree has uncommitted changes.',
            tokens: [6100, 210],
        }),
    },

    // the same follow-up, answered differently: a branch summary carries what
    // the abandoned path found, which is what /tree writes when you switch away
    {
        id: 'a000000e',
        parent: 'a0000009',
        at: 60,
        entry: {
            type: 'branch_summary',
            fromId: 'a000000d',
            summary:
                'The other branch added the short commit to --version output, read from `git rev-parse --short HEAD` at runtime, with a `dirty` marker when the work tree is not clean.',
            usage: usage(2100, 90),
            fromHook: false,
        },
    },
    { id: 'a000000f', parent: 'a000000e', at: 61, entry: user('actually, drop the commit. just the version') },
    {
        id: 'a0000010',
        parent: 'a000000f',
        at: 66,
        entry: assistant({
            thinking: 'Reverting the second edit only, not the flag itself.',
            text: 'Back to `0.4.1` alone. The git call is gone, so `--version` no longer spawns a process.',
            tokens: [6400, 150],
        }),
    },

    // second branch point: a question asked of the same reply, which failed
    { id: 'a0000011', parent: 'a0000009', at: 80, entry: user('what does the test suite say') },
    {
        id: 'a0000012',
        parent: 'a0000011',
        at: 83,
        entry: assistant({
            text: 'Running it.',
            calls: [{ id: 'call_04', name: 'bash', arguments: { command: 'bun test tests/release.test.ts' } }],
        }),
    },
    {
        id: 'a0000013',
        parent: 'a0000012',
        at: 96,
        entry: toolResult(
            'call_04',
            'bash',
            "(fail) release --version exits 0\nerror: expect(received).toBe(expected)\n\nExpected: 0\nReceived: 1\n\n 6 pass\n 1 fail\n",
            true,
        ),
    },
    {
        id: 'a0000014',
        parent: 'a0000013',
        at: 99,
        entry: assistant({
            thinking: 'The exit code is 1 because the flag is handled after the usage check.',
            stopReason: 'aborted',
            tokens: [7000, 40],
        }),
    },

    // the shapes an extension writes: a summary that stands in for a span, and
    // a compaction checkpoint
    {
        id: 'a0000015',
        parent: 'a0000010',
        at: 120,
        entry: {
            type: 'custom_message',
            customType: 'rho-summary',
            content:
                'Earlier: a --version flag was added to bin/release.ts, printing the version from package.json and exiting before argument parsing. A variant printing the short commit was tried and dropped.',
            display: true,
            details: { replaced: 6 },
        },
    },
    // a third branch point, on the branch the session is left on: two things
    // asked of the same summary, one of them abandoned
    { id: 'a0000018', parent: 'a0000015', at: 122, entry: user('tag the release from here') },
    {
        id: 'a0000019',
        parent: 'a0000018',
        at: 125,
        entry: assistant({
            text: 'Not from an uncommitted tree: the tag would point at a commit that does not have the flag in it.',
            tokens: [3300, 90],
        }),
    },
    {
        id: 'a0000016',
        parent: 'a0000015',
        at: 130,
        entry: user('now write the changelog entry for it'),
    },
    {
        id: 'a0000017',
        parent: 'a0000016',
        at: 134,
        entry: assistant({
            text: 'Added under Unreleased: `release --version prints the package version`.',
            tokens: [3200, 120],
        }),
    },
];

/** the sample session, as entries ready to be written to a session file. */
export function sampleEntries(start: number = START): SessionEntry[] {
    return DRAFTS.map((draft) => {
        const timestamp = new Date(start + draft.at * 1000).toISOString();
        const entry = { ...draft.entry, id: draft.id, parentId: draft.parent, timestamp } as SessionEntry;
        if (entry.type === 'message') {
            // the message's own clock is the entry's, so the transcript and the
            // tree agree about when something happened.
            entry.message = { ...entry.message, timestamp: start + draft.at * 1000 } as AgentMessage;
        }
        return entry;
    });
}

/** the entry the session opens on: the end of the branch that was kept. */
export const SAMPLE_LEAF = 'a0000017';

/** what the session is called in /resume. */
export const SAMPLE_NAME = 'Sample session';
