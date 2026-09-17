import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { refusal, verdict } from '../extensions/remove';
import { targetFor } from '../extensions/lib/acting-file';
import type { Said } from '../extensions/lib/file-store';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('what write may replace', () => {
    test('an absent file is written', () => {
        expect(verdict('/tmp/a', { kind: 'absent' }, null, 'anything')).toBeNull();
    });

    test('an empty file is written', () => {
        expect(verdict('/tmp/a', { kind: 'file', bytes: 0 }, null, 'anything')).toBeNull();
    });

    test('a file holding bytes is refused, and the refusal names the way through', () => {
        const reason = verdict('/tmp/a', { kind: 'file', bytes: 12 }, sha256('old'), 'new');
        expect(reason).not.toBeNull();
        expect(reason).toContain('edit');
        expect(reason).toContain('remove');
        expect(reason).toBe(refusal('/tmp/a', 12));
    });

    test('a write of the bytes already there is allowed', () => {
        expect(verdict('/tmp/a', { kind: 'file', bytes: 3 }, sha256('old'), 'old')).toBeNull();
    });

    test('a directory is refused for a different reason', () => {
        expect(verdict('/tmp/a', { kind: 'directory' }, null, 'x')).toContain('directory');
    });
});

describe('which machine a path names', () => {
    const attached = {
        name: 'gpubox',
        host: 'samuel@gpubox',
        cwd: '/srv/work',
        alive: true,
        capture: (): Promise<Said> => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    };

    test('a plain path with nothing attached is this machine, against the session cwd', () => {
        const target = targetFor('src/a.ts', '/Users/s/p', undefined);
        expect(target).toEqual({ kind: 'here', store: expect.objectContaining({ machine: 'local' }), path: '/Users/s/p/src/a.ts' });
    });

    test('a plain path with an environment attached is that machine, against its cwd', () => {
        const target = targetFor('a.ts', '/Users/s/p', attached);
        expect(target.kind).toBe('here');
        if (target.kind !== 'here') return;
        expect(target.store.machine).toBe('gpubox');
        expect(target.path).toBe('/srv/work/a.ts');
    });

    test('local: reaches this machine while an environment is attached', () => {
        const target = targetFor('local:/etc/hosts', '/Users/s/p', attached);
        expect(target.kind).toBe('here');
        if (target.kind !== 'here') return;
        expect(target.store.machine).toBe('local');
        expect(target.path).toBe('/etc/hosts');
    });

    test('an addressed path on the attached machine resolves to it', () => {
        const target = targetFor('samuel@gpubox:/srv/work/a.ts', '/Users/s/p', attached);
        expect(target.kind).toBe('here');
        if (target.kind !== 'here') return;
        expect(target.store.machine).toBe('gpubox');
    });

    test('an addressed path on a machine nothing is attached to is left alone', () => {
        expect(targetFor('samuel@other:/srv/a.ts', '/Users/s/p', attached)).toEqual({
            kind: 'elsewhere',
            address: 'samuel@other',
        });
    });

    test('a leading @ from a confused model is stripped', () => {
        const target = targetFor('@/etc/hosts', '/Users/s/p', undefined);
        expect(target.kind === 'here' && target.path).toBe('/etc/hosts');
    });
});
