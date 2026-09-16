import { test, expect } from 'bun:test';
import { GUTTER, gutterText, markRow, markRows } from '../extensions/lib/tree-gutter';
import { plain, visibleWidth } from '../extensions/lib/text';

test('every mark is exactly the width of the gutter it replaces', () => {
    expect(visibleWidth(gutterText({ kind: 'cursor' }))).toBe(GUTTER);
    expect(visibleWidth(gutterText({ kind: 'selected' }))).toBe(GUTTER);
    expect(visibleWidth(gutterText({ kind: 'distance', rows: 7 }))).toBe(GUTTER);
    expect(visibleWidth(gutterText({ kind: 'distance', rows: 12 }))).toBe(GUTTER);
    expect(visibleWidth(gutterText({ kind: 'blank' }))).toBe(GUTTER);
});

test('a count past two digits is not shown rather than pushing the row right', () => {
    expect(plain(gutterText({ kind: 'distance', rows: 120 }))).toBe('  ');
});

test('marking a row keeps the styling of the rest of the line', () => {
    const line = '  \x1b[2m├─ \x1b[22muser: hello';
    const marked = markRow(line, { kind: 'cursor' });
    expect(plain(marked)).toBe('\u203a \u251c\u2500 user: hello');
    expect(marked).toContain('\x1b[2m');
    expect(visibleWidth(marked)).toBe(visibleWidth(line));
});

test('rows are marked by their place in the whole list, not the viewport', () => {
    const lines = ['  a', '  b', '  c', '  (2/9)'];
    const out = markRows(lines, 3, {
        cursor: 6,
        selected: new Set([5, 6]),
        reachable: new Set([5, 6, 7]),
        firstRow: 5,
    });
    expect(out.map(plain)).toEqual(['\u2503 a', '\u203a b', ' 1c', '  (2/9)']);
});

test('a shape the renderer did not produce is left alone', () => {
    const lines = ['  a', '  b'];
    const out = markRows(lines, 3, { cursor: 0, selected: new Set(), reachable: new Set(), firstRow: 0 });
    expect(out).toEqual(lines);
});
