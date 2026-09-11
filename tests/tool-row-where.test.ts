import { describe, expect, test } from 'bun:test';
import { callPreview } from '../extensions/lib/tool-row/preview';
import { visibleWidth } from '../extensions/lib/text';

/**
 * A command that ran on another machine looked exactly like one that ran here.
 * The machine is shown on the right of the row, and only when it is not the one
 * the session points at, so a session that never leaves one machine gains no
 * decoration.
 */

const row = (args: unknown, where?: string, width = 74): string =>
    callPreview({ title: 'bash', args, where, expanded: false, width })[0] ?? '';

describe('the machine on a call row', () => {
    test('is absent when the call ran where the session points', () => {
        expect(row({ command: 'uname -a' })).not.toContain('(');
    });

    test('is on the right when it ran elsewhere', () => {
        const line = row({ command: 'uname -a' }, 'samuel@dev-box-1');
        expect(line).toContain('uname -a');
        expect(line.trimEnd().endsWith('(samuel@dev-box-1)')).toBe(true);
    });

    test('names the laptop when a command was sent back to it', () => {
        expect(row({ command: 'git status' }, 'local').trimEnd().endsWith('(local)')).toBe(true);
    });

    test('never exceeds the width, which crashes pi', () => {
        for (const width of [20, 30, 40, 74, 200]) {
            const line = row({ command: 'x'.repeat(120) }, 'samuel@dev-box-1', width);
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
    });

    test('keeps the command visible rather than replacing it', () => {
        // The first attempt used the note field, which substitutes for the
        // subject: the row then showed the machine and not the command.
        expect(row({ command: 'uname -a' }, 'samuel@box')).toContain('uname -a');
    });
});
