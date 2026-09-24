import { test, expect } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { borderStatus, cutInto } from '../extensions/lib/chrome/working-status';
import { plain } from '../extensions/lib/core/text';

const EDGE = (width: number) => '\u2584'.repeat(width);

function fakeEditor(message: string, spinner: string, embed = true) {
    return {
        embedWorkingStatus: embed,
        workingStatusIndicator: {
            renderInBorder: (width: number) => message.slice(0, width),
            renderSpinnerInBorder: (width: number) => spinner.slice(0, width),
        },
    };
}

test('cutInto keeps the row width', () => {
    const row = EDGE(40);
    const out = cutInto(row, '\x1b[31mworking\x1b[0m', 40);
    expect(visibleWidth(out)).toBe(40);
    expect(plain(out)).toBe('▄▄ working ' + '▄'.repeat(29));
});

test('cutInto places the status two cells in, with a space either side', () => {
    expect(plain(cutInto(EDGE(20), 'ab', 20))).toBe('\u2584\u2584 ab \u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584');
});

test('a two-column glyph covers two cells of the row', () => {
    const out = cutInto(EDGE(20), '\u4e36 ok', 20);
    expect(visibleWidth(out)).toBe(20);
    expect(plain(out).startsWith('\u2584\u2584 \u4e36 ok \u2584')).toBe(true);
});

test('cutInto leaves a row with no room for the status alone', () => {
    const row = EDGE(6);
    expect(cutInto(row, 'abcdef', 6)).toBe(row);
});

test('cutInto preserves the escapes of the cells it covers', () => {
    const row = '\x1b[38;2;1;2;3m\u2584\x1b[38;2;4;5;6m\u2584\x1b[38;2;7;8;9m\u2584\u2584\u2584\u2584';
    const out = cutInto(row, 'x', 6);
    expect(visibleWidth(out)).toBe(6);
    expect(out).toContain('\x1b[38;2;1;2;3m');
    expect(out).toContain('\x1b[38;2;7;8;9m');
});

test('an editor with no indicator has no border status', () => {
    expect(borderStatus({ embedWorkingStatus: true }, 80)).toBeUndefined();
});

test('an editor that does not embed the status has none to cut in', () => {
    expect(borderStatus(fakeEditor('working', '*', false), 80)).toBeUndefined();
});

// pi truncates the message to the room the border has, so a narrow row
// shortens it rather than dropping to the spinner; the spinner is what a
// message of nothing falls back to.
test('the message is used when it fits, and is cut to the room when it does not', () => {
    expect(borderStatus(fakeEditor('working', '*'), 80)).toBe('working');
    expect(borderStatus(fakeEditor('working', '*'), 8)).toBe('wor');
});

test('an indicator rendering no message falls back to the spinner', () => {
    expect(borderStatus(fakeEditor('', '*'), 80)).toBe('*');
});

test('what borderStatus returns always fits the row it was measured for', () => {
    for (const width of [10, 20, 40, 80]) {
        const status = borderStatus(fakeEditor('a'.repeat(200), '*'), width);
        expect(status).toBeDefined();
        expect(visibleWidth(status!) + 4).toBeLessThanOrEqual(width);
        expect(visibleWidth(cutInto(EDGE(width), status!, width))).toBe(width);
    }
});

test('a row too narrow for anything yields nothing', () => {
    expect(borderStatus(fakeEditor('working', '*'), 3)).toBeUndefined();
});
