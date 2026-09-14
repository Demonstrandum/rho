import { describe, expect, test } from 'bun:test';
import { resolveShorthand, shorthandComplaint, shorthandFor } from '../extensions/lib/shorthand';

const REMOTE = ['create', 'connect', 'project', 'list', 'stop'];

describe('the shortest thing that still means one subcommand', () => {
    test('a whole name is itself, even when it starts another one', () => {
        expect(resolveShorthand('list', REMOTE)).toEqual({ kind: 'exact', name: 'list' });
        // `on` would be a prefix of nothing here, but the rule is what matters:
        // a name is never read as a shortening of a longer one.
        expect(resolveShorthand('on', ['on', 'online'])).toEqual({ kind: 'exact', name: 'on' });
    });

    test('a prefix that belongs to one name is that name', () => {
        expect(shorthandFor('l', REMOTE)).toBe('list');
        expect(shorthandFor('pro', REMOTE)).toBe('project');
        expect(shorthandFor('st', REMOTE)).toBe('stop');
    });

    test('a substring is tried only when no name begins with the word', () => {
        expect(resolveShorthand('x', ['remix', 'play'])).toEqual({ kind: 'substring', name: 'remix' });
        // `re` begins remix, so the prefix answer wins and rewind is not
        // consulted for a substring.
        expect(resolveShorthand('re', ['remix', 'wind'])).toEqual({ kind: 'prefix', name: 'remix' });
    });

    test('a word that fits several names is ambiguous, and says which', () => {
        expect(resolveShorthand('c', REMOTE)).toEqual({ kind: 'ambiguous', between: ['create', 'connect'] });
        expect(shorthandFor('c', REMOTE)).toBeNull();
        expect(shorthandComplaint('c', REMOTE)).toBe('c could be create or connect');
    });

    test('an ambiguous prefix does not fall through to a substring', () => {
        // `o` begins nothing, so it is a substring of both: still ambiguous.
        expect(resolveShorthand('o', ['stop', 'project'])).toEqual({
            kind: 'ambiguous',
            between: ['stop', 'project'],
        });
        // `st` begins one and is inside the other: the prefix decides.
        expect(resolveShorthand('st', ['stop', 'list'])).toEqual({ kind: 'prefix', name: 'stop' });
    });

    test('case is not part of a verb', () => {
        expect(shorthandFor('L', REMOTE)).toBe('list');
        expect(shorthandFor('CONNECT', REMOTE)).toBe('connect');
    });

    test('a word matching nothing is unknown, and the complaint lists what there is', () => {
        expect(resolveShorthand('zz', REMOTE)).toEqual({ kind: 'unknown' });
        expect(shorthandComplaint('zz', REMOTE)).toBe(
            'no such subcommand: zz. one of create, connect, project, list, stop',
        );
    });

    test('nothing typed matches nothing', () => {
        expect(resolveShorthand('', REMOTE)).toEqual({ kind: 'unknown' });
        expect(resolveShorthand('   ', REMOTE)).toEqual({ kind: 'unknown' });
    });
});
