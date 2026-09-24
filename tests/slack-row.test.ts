import { describe, expect, test } from 'bun:test';
import { slackCall, slackResult, type RowContext } from '../extensions/slack/row';
import { PLAIN_THEME } from '../extensions/lib/tool-row/theme';

const NAMES: Readonly<Record<string, string>> = { D0C2SA7A1EY: 'Samuel', C07J1N8Q0RH: '#robotics' };
const TS = '1731000000.000100';

const room = (expanded = false): RowContext => ({
    theme: PLAIN_THEME,
    width: 80,
    expanded,
    named: (id) => NAMES[id] ?? id,
});

const call = (tool: string, args: Record<string, unknown>, expanded = false): readonly string[] =>
    slackCall(tool, args, room(expanded)) ?? [];

const answer = (tool: string, args: Record<string, unknown>, text: string, expanded = false): readonly string[] =>
    slackResult(tool, args, text, room(expanded)) ?? [];

describe('what a row says happened', () => {
    test('the verb is the action, not the tool', () => {
        expect(call('slack_manage_message', { action: 'react', ts: TS, channel: 'D0C2SA7A1EY', emoji: '+1' })).toEqual([
            "slack react :+1: to Samuel's 17:20 message",
        ]);
        expect(call('slack_manage_message', { action: 'delete', ts: TS, channel: 'D0C2SA7A1EY' })).toEqual([
            'slack delete your 17:20 message to Samuel',
        ]);
        expect(call('slack_manage_message', { action: 'permalink', ts: TS, channel: 'C07J1N8Q0RH' })).toEqual([
            'slack link the 17:20 message in #robotics',
        ]);
    });

    test('a message this app sent is ours, and one it reacts to is theirs', () => {
        const [edit] = call('slack_manage_message', { action: 'update', ts: TS, channel: 'D0C2SA7A1EY', text: 'fixed' });
        const [react] = call('slack_manage_message', { action: 'react', ts: TS, channel: 'D0C2SA7A1EY', emoji: 'eyes' });
        expect(edit).toContain('your 17:20 message to Samuel');
        expect(react).toContain("Samuel's 17:20 message");
    });

    test('the text a call carries is quoted, and its ids wait for the expanded row', () => {
        expect(call('slack_reply', { text: 'one sec', channel: 'D0C2SA7A1EY' })).toEqual([
            'slack reply to Samuel',
            '> one sec',
        ]);
        expect(call('slack_reply', { text: 'one sec', channel: 'D0C2SA7A1EY', thread: TS }, true)).toEqual([
            'slack reply to Samuel in thread',
            '> one sec',
            'D0C2SA7A1EY',
            `thread ${TS}`,
        ]);
    });

    test('a time to send is read as a person says it', () => {
        expect(call('slack_schedule', { action: 'send', when: '+8h', channel: 'D0C2SA7A1EY', text: 'morning' })[0]).toBe(
            'slack schedule in 8h to Samuel',
        );
    });

    test('a tool with no row here declines rather than guessing', () => {
        expect(slackCall('web_search', { query: 'x' }, room())).toBeNull();
    });
});

describe('what a row says came back', () => {
    test('a confirmation of what the call already named is dropped', () => {
        expect(answer('slack_reply', { channel: 'D0C2SA7A1EY' }, `Sent to D0C2SA7A1EY as ${TS}.`)).toEqual([]);
        expect(answer('slack_manage_message', { action: 'react' }, `Added :+1: on ${TS}.`)).toEqual([]);
    });

    test('a refusal survives, because the call did not say it', () => {
        expect(answer('slack_reply', { channel: 'D0C2SA7A1EY' }, 'Slack refused it: channel_not_found')).toEqual([
            'Slack refused it: channel_not_found',
        ]);
    });

    test('an answer the call could not predict is kept', () => {
        expect(answer('slack_manage_message', { action: 'permalink' }, 'https://x.slack.com/archives/C1/p1')).toEqual([
            'https://x.slack.com/archives/C1/p1',
        ]);
    });

    test('a listing collapses to what it found, a conversation to its last message', () => {
        const people = '2 people:\n  U09L8EEPUTC dm D0A1B2C3D4E Mathis Wellmann (Europe/Berlin)\n  U0C2SA7A1EY Samuel';
        expect(answer('slack_directory', { kind: 'people' }, people)).toEqual(['Mathis Wellmann, Samuel']);
        // the names, then a count of the ones the row had no room for.
        const many = ['8 people:', ...Array.from({ length: 8 }, (_, i) => `  U09L8EEPUT${i} Person Number ${i}`)];
        expect(answer('slack_directory', { kind: 'people' }, many.join('\n'))[0]).toMatch(/Person Number 0.*\[\d more\]$/);
        expect(answer('slack_read', { channel: 'D0C2SA7A1EY' }, 'D0C2SA7A1EY, 2 messages:\n[17:02] a\n[17:05] b')).toEqual(
            ['[17:05] b'],
        );
    });
});
