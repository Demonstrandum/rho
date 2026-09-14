import { describe, expect, test } from 'bun:test';
import { lastSaid, troubleWith } from '../extensions/lib/remote/advice';

/**
 * The interface that launches the client redraws the screen the moment it
 * returns, so whatever the client wrote is gone before it can be read:
 * connecting to a stopped session looked like being bounced straight back with
 * nothing said.
 */

describe('what the client stopped for', () => {
    test('is the last thing it said, not the first', () => {
        expect(lastSaid('warming up\n\nno session called demo\n\n')).toBe('no session called demo');
    });

    test('a session that is not running says how to start it again', () => {
        const trouble = troubleWith('no session called demo', 'demo', 'me@host');
        expect(trouble.reason).toBe('no session called demo');
        expect(trouble.advice).toBe('/remote connect demo me@host starts it again, and keeps what it said before');
    });

    test('a host with nothing installed says what installs it', () => {
        expect(troubleWith('me@host has no session runner installed', 'demo', 'me@host').advice).toContain(
            '/remote create demo me@host',
        );
    });

    test('a directory that is not there says to name one that is', () => {
        expect(troubleWith('/home/me/nope does not exist on this machine', 'demo', 'me@host').advice).toContain(
            'a directory that is there',
        );
    });

    test('ssh trouble is answered with the command that tests ssh', () => {
        for (const reason of ['Permission denied (publickey).', 'ssh: connect to host x: Connection refused']) {
            expect(troubleWith(reason, 'demo', 'me@host').advice).toBe('ssh me@host true says whether this machine can reach it at all');
        }
    });

    test('a link that closed asks what is still there', () => {
        expect(troubleWith('the link closed (exit 0)', 'demo', 'me@host').advice).toBe(
            '/remote list me@host says whether demo is still there',
        );
    });

    test('silence is reported as silence rather than as nothing', () => {
        const trouble = troubleWith('   \n\n', 'demo', 'me@host');
        expect(trouble.reason).toBe('demo on me@host closed without saying why');
        expect(trouble.advice).toBe('/remote list me@host');
    });

    test('a reason with no advice keeps the reason', () => {
        const trouble = troubleWith('something nobody has seen before', 'demo', 'me@host');
        expect(trouble.reason).toBe('something nobody has seen before');
        expect(trouble.advice).toBeNull();
    });
});
