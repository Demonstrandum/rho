import { describe, expect, test } from 'bun:test';

/**
 * `user@host:/path` names a file and the machine it is on in one argument.
 *
 * The parse is the whole contract: anything it wrongly claims is addressed
 * goes to another machine, and anything it wrongly rejects silently stays
 * here. Both are the wrong-machine failure this design exists to avoid, so the
 * pattern is pinned rather than left to be rediscovered.
 */
const ADDRESSED = /^([A-Za-z0-9._-]+@[A-Za-z0-9._-]+|local):(\/.*)$/;

const parse = (text: string): { where: string; path: string } | null => {
    const found = ADDRESSED.exec(text);
    return found === null ? null : { where: found[1] ?? '', path: found[2] ?? '' };
};

describe('an addressed path', () => {
    test('names the machine and the file', () => {
        expect(parse('samuel@dev-box:/etc/os-release')).toEqual({
            where: 'samuel@dev-box',
            path: '/etc/os-release',
        });
    });

    test('addresses this machine with local', () => {
        expect(parse('local:/Users/samuel/Git/mock/README.md')).toEqual({
            where: 'local',
            path: '/Users/samuel/Git/mock/README.md',
        });
    });

    test('takes an address by ip', () => {
        expect(parse('ubuntu@10.0.0.1:/srv/web/state')?.where).toBe('ubuntu@10.0.0.1');
    });
});

describe('what is not an addressed path', () => {
    test('a plain absolute path means the current environment', () => {
        expect(parse('/srv/web/state/symbol')).toBeNull();
    });

    test('a relative path is not addressed either', () => {
        expect(parse('./notes.md')).toBeNull();
    });

    test('a windows drive letter is not a host', () => {
        // The one case that would quietly send a local file to another machine.
        expect(parse('C:/windows/style')).toBeNull();
    });

    test('a host with a relative path is refused rather than guessed at', () => {
        // Relative to what? The remote directory is the session's, not the
        // caller's, so a relative path here would mean something different
        // depending on when it ran.
        expect(parse('samuel@host:notes.md')).toBeNull();
    });
});
