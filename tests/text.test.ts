import { expect, test } from 'bun:test';
import {
    abbreviate,
    ago,
    collapseHome,
    duration,
    elidePath,
    isBlank,
    oneLine,
    omitTail,
    percent,
    plain,
    plural,
    preview,
    quantity,
    series,
    spliceVisible,
    truncate,
    visibleWidth,
    words,
} from '../extensions/lib/core/text';

test('plain drops every escape and keeps the characters', () => {
    const styled = '\x1b[1m\x1b[38;2;1;2;3mread\x1b[39m\x1b[22m file.ts';
    expect(plain(styled)).toBe('read file.ts');
    expect(visibleWidth(styled)).toBe(12);
    expect(isBlank('\x1b[2m   \x1b[22m')).toBe(true);
    expect(isBlank('\x1b[2m x \x1b[22m')).toBe(false);
});

test('spliceVisible replaces visible columns and leaves the styling in place', () => {
    const line = '\x1b[1mread\x1b[22m file.ts';
    expect(spliceVisible(line, 0, 4, 'open')).toBe('\x1b[1mopen\x1b[22m file.ts');
    // a replacement spanning a style boundary is placed once, not per span.
    const split = '\x1b[1mre\x1b[22m\x1b[2mad\x1b[22m x';
    expect(plain(spliceVisible(split, 0, 4, 'open'))).toBe('open x');
});

test('truncate spends the last columns on the marker', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello world', 8)).toBe('hello w\u2026');
    expect(truncate('hello', 1, '...')).toBe('.');
    expect(preview('  two\nlines  ', 20)).toBe('two lines');
    expect(preview('a'.repeat(30), 10)).toBe('aaaaaaa...');
});

test('oneLine folds every run of whitespace', () => {
    expect(oneLine('a\n\tb   c ')).toBe('a b c');
});

test('omitTail says how much it dropped', () => {
    expect(omitTail('abcdef', 10)).toBe('abcdef');
    expect(omitTail('abcdef', 3)).toBe('abc\n[...3 characters omitted]');
});

test('elidePath keeps enough of the tail to name the directory', () => {
    expect(elidePath('/a/b/c/pi-coding-agent/dist')).toBe('[\u2026]/pi-coding-agent/dist');
    expect(elidePath('/short/p')).toBe('/short/p');
    expect(elidePath('notapath')).toBe('notapath');
});

test('plural, quantity and series', () => {
    expect(plural(1, 'file')).toBe('file');
    expect(plural(2, 'file')).toBe('files');
    expect(plural(2, 'entry', 'entries')).toBe('entries');
    expect(quantity(1, 'conversation')).toBe('1 conversation');
    expect(quantity(0, 'conversation')).toBe('0 conversations');
    expect(series([])).toBe('');
    expect(series(['a'])).toBe('a');
    expect(series(['a', 'b'])).toBe('a and b');
    expect(series(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(series(['a', 'b'], 'or')).toBe('a or b');
});

test('abbreviate keeps a status line fixed and a readout exact', () => {
    const rows: [number, string, string][] = [
        [999, '999', '999'],
        [1234, '1.2k', '1.2k'],
        [2000, '2.0k', '2k'],
        [15234, '15k', '15.2k'],
        [1_500_000, '1.5M', '1.5M'],
        [200_000, '200k', '200k'],
    ];
    for (const [value, compact, fine] of rows) {
        expect(abbreviate(value, 'compact')).toBe(compact);
        expect(abbreviate(value, 'fine')).toBe(fine);
    }
});

test('percent of an empty whole is zero rather than a division', () => {
    expect(percent(1, 4)).toBe('25.0');
    expect(percent(1, 0)).toBe('0.0');
});

test('duration and ago', () => {
    const rows: [number, string][] = [[0, '0s'], [999, '1s'], [12000, '12s'], [65000, '1m 5s'], [3600000, '60m 0s']];
    for (const [ms, want] of rows) expect(duration(ms)).toBe(want);

    const now = 1_000_000_000_000;
    expect(ago(now - 5_000, now)).toBe('5s ago');
    expect(ago(now - 300_000, now)).toBe('5m ago');
    expect(ago(now - 7_200_000, now)).toBe('2h ago');
    expect(ago(now - 3 * 86_400_000, now)).toBe('3d ago');
    expect(ago(now + 5_000, now)).toBe('0s ago');
});

test('words splits every identifier convention', () => {
    expect(words('ctx_execute_file')).toEqual(['ctx', 'execute', 'file']);
    expect(words('mcp__brave__search')).toEqual(['mcp', 'brave', 'search']);
    expect(words('webSearch')).toEqual(['web', 'Search']);
    expect(words('claude-opus-4-8')).toEqual(['claude', 'opus', '4', '8']);
});

test('collapseHome writes a path the way it is typed', () => {
    expect(collapseHome('/home/sam/code', '/home/sam')).toBe('~/code');
    expect(collapseHome('/home/sam', '/home/sam')).toBe('~');
    expect(collapseHome('/etc/hosts', '/home/sam')).toBe('/etc/hosts');
    expect(collapseHome('/etc/hosts', undefined)).toBe('/etc/hosts');
});
