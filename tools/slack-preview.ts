#!/usr/bin/env bun
// what the Slack extension puts on screen, drawn outside a session.
//
//   bun run slack:preview                 every row and both message boxes
//   bun run slack:preview -- --width 60   at a narrower terminal
//   bun run slack:preview -- --theme dark under a named theme
//   bun run slack:preview -- react edit   only the scenarios whose name matches
//
// nothing here draws anything itself. the rows come from the functions
// tool-rows.ts installs on pi's component (toolTitle, callPreview,
// resultPreview, adaptTheme, noteOn), and the arriving message comes from the
// renderer slack.ts registers, reached by handing the extension a pi whose
// registerMessageRenderer keeps what it is given. a preview that redrew any of
// that would be previewing itself.
//
// the theme is pi's own, loaded by name through initTheme, so the colours are
// the colours a session shows.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Component } from '@earendil-works/pi-tui';
import {
    getAgentDir,
    initTheme,
    SettingsManager,
    type ExtensionAPI,
    type MessageRenderer,
    type Theme,
} from '@earendil-works/pi-coding-agent';
import slack from '../extensions/slack';
import { adaptTheme, noteOn, rowTitle } from '../extensions/tool-rows';
import { callPreview, resultPreview } from '../extensions/lib/tool-row/preview';
import { setNote } from '../extensions/lib/tool-row/notes';

const SAMUEL = 'D0C2SA7A1EY';
const CHANNEL = 'C07J1N8Q0RH';
const TS = '1731000000.000100';

interface Row {
    readonly name: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    /** what the tool answered, as its execute returns it. */
    readonly result: string;
}

interface Arrival {
    readonly name: string;
    readonly content: string;
    readonly details: {
        readonly name: string;
        readonly channel: string;
        readonly ts: string;
        readonly text: string;
        readonly files: readonly { readonly name: string; readonly path: string; readonly bytes: number }[];
    };
}

const ROWS: readonly Row[] = [
    {
        name: 'reply',
        tool: 'slack_reply',
        args: { text: 'one sec, looking now', channel: SAMUEL },
        result: `Sent to ${SAMUEL} as ${TS}.`,
    },
    {
        name: 'reply-thread',
        tool: 'slack_reply',
        args: { text: 'the build is green again', channel: CHANNEL, thread: TS },
        result: `Sent to ${CHANNEL} in thread ${TS} as 1731000900.000200.`,
    },
    {
        name: 'file',
        tool: 'slack_send_file',
        args: { path: 'reports/latency.png', comment: 'p99 over the week', channel: SAMUEL },
        result: `Sent latency.png to ${SAMUEL}.`,
    },
    {
        name: 'read',
        tool: 'slack_read',
        args: { channel: SAMUEL, limit: 3 },
        result: `${SAMUEL}, 3 messages:\n[17:02 UTC ${TS}] Samuel: is the deploy out\n[17:03 UTC 1731000180.000100] code-bot: not yet, two checks left\n[17:05 UTC 1731000300.000100] Samuel: great`,
    },
    {
        name: 'directory-people',
        tool: 'slack_directory',
        args: { query: 'mathis', kind: 'people' },
        result: '1 person:\n  U09L8EEPUTC dm D0A1B2C3D4E Mathis Wellmann (Europe/Berlin)',
    },
    {
        name: 'directory-conversations',
        tool: 'slack_directory',
        args: { kind: 'conversations', limit: 40 },
        result: `2 conversations:\n  ${SAMUEL} Samuel (im, member)\n  ${CHANNEL} #robotics (channel, member, 14 people)`,
    },
    {
        name: 'react',
        tool: 'slack_manage_message',
        args: { action: 'react', ts: TS, channel: SAMUEL, emoji: '+1' },
        result: `Added :+1: on ${TS}.`,
    },
    {
        name: 'unreact',
        tool: 'slack_manage_message',
        args: { action: 'unreact', ts: TS, channel: SAMUEL, emoji: 'eyes' },
        result: `Removed :eyes: on ${TS}.`,
    },
    {
        name: 'edit',
        tool: 'slack_manage_message',
        args: { action: 'update', ts: TS, channel: SAMUEL, text: 'correction: 47 files, not 44' },
        result: `Rewrote ${TS}.`,
    },
    {
        name: 'delete',
        tool: 'slack_manage_message',
        args: { action: 'delete', ts: TS, channel: SAMUEL },
        result: `Deleted ${TS}.`,
    },
    {
        name: 'permalink',
        tool: 'slack_manage_message',
        args: { action: 'permalink', ts: TS, channel: CHANNEL },
        result: `https://example.slack.com/archives/${CHANNEL}/p1731000000000100`,
    },
    {
        name: 'schedule',
        tool: 'slack_schedule',
        args: { action: 'send', when: '+8h', text: 'morning, the migration finished overnight', channel: SAMUEL },
        result: `Held for 2026-09-18T01:00:00.000Z in ${SAMUEL}, id Q1298393284.`,
    },
    {
        name: 'schedule-list',
        tool: 'slack_schedule',
        args: { action: 'list' },
        result: `Q1298393284 ${SAMUEL} 2026-09-18T01:00:00.000Z morning, the migration finished overnight`,
    },
    {
        name: 'done',
        tool: 'slack_done',
        args: {},
        result: 'Slack exchange closed.',
    },
];

const ARRIVALS: readonly Arrival[] = [
    {
        name: 'message',
        content: [
            `A Slack message arrived.`,
            `[17:05 UTC ${TS}] Samuel in ${SAMUEL}: great`,
            '',
            'Answer Samuel in Slack: a line or two, as a colleague writes, and the detail stays in the terminal. Whatever you write last in this turn is sent to Slack, including a sentence saying no reply is needed: to end without sending anything, react with slack_manage_message and call slack_done. slack_reply sends sooner or to someone else, slack_manage_message reacts to or edits a message, slack_read and slack_directory look things up.',
        ].join('\n'),
        details: { name: 'Samuel', channel: SAMUEL, ts: TS, text: 'great', files: [] },
    },
    {
        name: 'message-files',
        content: [
            `A Slack message arrived.`,
            `[17:11 UTC 1731000660.000100] Samuel in ${SAMUEL}: this is what the panel looks like now`,
            'Files, already downloaded and readable at these paths:',
            '  /tmp/scratch/slack/F09ABCDEF-panel.png (panel.png, 284119 bytes)',
        ].join('\n'),
        details: {
            name: 'Samuel',
            channel: SAMUEL,
            ts: '1731000660.000100',
            text: 'this is what the panel looks like now',
            files: [{ name: 'panel.png', path: '/tmp/scratch/slack/F09ABCDEF-panel.png', bytes: 284119 }],
        },
    },
];

/** the value after a flag, or null when the flag is absent. */
function flag(argv: readonly string[], name: string): string | null {
    const at = argv.indexOf(`--${name}`);
    if (at < 0) return null;
    return argv[at + 1] ?? null;
}

/**
 * The theme this machine's pi is set to.
 *
 * The same two calls pi makes at startup: the name from settings, and
 * initTheme to load it. getTheme answers undefined for an auto "light/dark"
 * setting, and initTheme then detects the terminal background, which is again
 * what a session does. --theme overrides both.
 *
 * The object initTheme writes is not exported, only the function that writes
 * it, so it is read from the module it was written to. That path is resolved
 * from the package entry rather than written out, because the entry has moved
 * between releases.
 */
async function liveTheme(name: string | null): Promise<Theme> {
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const module = (await import(join(dirname(entry), 'modes/interactive/theme/theme.js'))) as { theme: Theme };
    const settings = SettingsManager.create(process.cwd(), getAgentDir());
    initTheme(name ?? settings.getTheme());
    return module.theme;
}

/**
 * The renderer slack.ts registers, by loading the extension with a pi that
 * records what it is handed. Everything else the factory reaches for is
 * accepted and dropped: no session starts, no socket opens.
 */
function deliveryRenderer(): MessageRenderer<unknown> | null {
    let drawn: MessageRenderer<unknown> | null = null;
    const pi = {
        registerMessageRenderer: (_type: string, renderer: MessageRenderer<unknown>) => {
            drawn = renderer;
        },
        registerTool: () => {},
        registerCommand: () => {},
        registerEntryRenderer: () => {},
        on: () => {},
        sendMessage: () => {},
    } as unknown as ExtensionAPI;
    slack(pi);
    return drawn;
}

function render(component: Component, width: number): string[] {
    return component.render(width);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const width = Number.parseInt(flag(argv, 'width') ?? '', 10) || process.stdout.columns || 80;
    const theme = await liveTheme(flag(argv, 'theme'));
    const wanted = argv.filter((word) => !word.startsWith('--') && !['dark', 'light'].includes(word));
    const chosen = (name: string): boolean => wanted.length === 0 || wanted.some((word) => name.includes(word));

    // the name behind a DM id, which slack.ts writes when a message arrives and
    // the rows read back. without it the preview would show ids where a
    // session shows people.
    setNote(SAMUEL, 'Samuel');
    setNote(CHANNEL, '#robotics');

    const rowTheme = adaptTheme(theme);
    const rule = (text: string) => theme.fg('dim', `${text} ${'-'.repeat(Math.max(0, width - text.length - 1))}`);

    for (const row of ROWS) {
        if (!chosen(row.name)) continue;
        console.log(rule(`${row.name}  (${row.tool})`));
        for (const expanded of [false, true]) {
            console.log(theme.fg('muted', expanded ? '  expanded' : '  collapsed'));
            const title = rowTitle(row.tool);
            const call = callPreview({
                title,
                args: row.args,
                note: noteOn(row.args),
                expanded,
                width: width - 4,
                theme: rowTheme,
            });
            const answer = resultPreview({
                text: row.result,
                args: row.args,
                note: noteOn(row.args),
                expanded,
                width: width - 4,
                theme: rowTheme,
            });
            for (const line of [...call, ...answer]) console.log(`    ${line}`);
        }
        console.log('');
    }

    const draw = deliveryRenderer();
    if (draw === null) {
        console.log(theme.fg('error', 'slack.ts registered no message renderer'));
        return;
    }
    for (const arrival of ARRIVALS) {
        if (!chosen(arrival.name)) continue;
        console.log(rule(arrival.name));
        for (const expanded of [false, true]) {
            console.log(theme.fg('muted', expanded ? '  expanded' : '  collapsed'));
            const component = draw(
                { customType: 'slack', content: arrival.content, display: true, details: arrival.details } as never,
                { expanded, outputPad: 1 },
                theme,
            );
            if (component === undefined) continue;
            for (const line of render(component, width - 4)) console.log(`    ${line}`);
        }
        console.log('');
    }
}

await main();
