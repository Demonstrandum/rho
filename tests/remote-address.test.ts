import { describe, expect, test } from 'bun:test';
import {
    addressName,
    parseAddress,
    parseLocated,
    sshTarget,
    describeWhere,
} from '../extensions/lib/remote/address';

describe('parseAddress', () => {
    test('user and host', () => {
        expect(parseAddress('samuel@robotics-vm-1')).toEqual({
            user: 'samuel',
            host: 'robotics-vm-1',
            path: null,
        });
    });

    test('a bare word is a host, not a user', () => {
        expect(parseAddress('robotics-vm-1')).toEqual({ user: null, host: 'robotics-vm-1', path: null });
    });

    test('a directory comes with it', () => {
        expect(parseAddress('samuel@box:/srv/work')).toEqual({
            user: 'samuel',
            host: 'box',
            path: '/srv/work',
        });
    });

    test('a relative directory is refused, since it means a different file each time', () => {
        expect(parseAddress('samuel@box:work')).toBeNull();
    });

    test('nonsense is null rather than a host called nonsense', () => {
        expect(parseAddress('two words')).toBeNull();
        expect(parseAddress('')).toBeNull();
        expect(parseAddress('@host')).toBeNull();
    });

    test('the ssh form comes back out', () => {
        const address = parseAddress('samuel@box:/srv');
        expect(address).not.toBeNull();
        if (address !== null) {
            expect(sshTarget(address)).toBe('samuel@box');
            expect(addressName(address)).toBe('box');
        }
    });

    test('a host with no user keeps the ssh form the caller typed', () => {
        const address = parseAddress('box');
        if (address !== null) expect(sshTarget(address)).toBe('box');
    });
});

describe('parseLocated', () => {
    test('an addressed path names its machine', () => {
        const located = parseLocated('samuel@robotics-vm-1:/etc/os-release');
        expect(located.path).toBe('/etc/os-release');
        expect(located.where.kind).toBe('remote');
        if (located.where.kind === 'remote') expect(located.where.address.host).toBe('robotics-vm-1');
    });

    test('local names this machine', () => {
        expect(parseLocated('local:/Users/samuel/x')).toEqual({
            where: { kind: 'local' },
            path: '/Users/samuel/x',
        });
    });

    test('a bare path is the current environment, not this machine', () => {
        // The distinction that matters: while attached, an unqualified path
        // means the attached machine, and reading it as local writes to the
        // wrong host.
        expect(parseLocated('/srv/web/state').where.kind).toBe('current');
    });

    test('a windows drive letter is not a host', () => {
        const located = parseLocated('C:/windows/style');
        expect(located.where.kind).toBe('current');
        expect(located.path).toBe('C:/windows/style');
    });

    test('a relative path stays whole', () => {
        expect(parseLocated('./notes.md')).toEqual({ where: { kind: 'current' }, path: './notes.md' });
    });
});

describe('describeWhere', () => {
    test('says what a person would say', () => {
        expect(describeWhere({ kind: 'local' })).toBe('local');
        expect(describeWhere({ kind: 'current' })).toBe('the current environment');
        expect(describeWhere({ kind: 'remote', address: { user: 'samuel', host: 'box', path: null } })).toBe(
            'samuel@box',
        );
    });
});
