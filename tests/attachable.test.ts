import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachable, offers, publishConnect, publishedConnect, readLedger, remember, writeLedger } from '../extensions/lib/remote/sessions';

/**
 * A name is resolved against two records that were written by two extensions,
 * and `pi --attach` reads both: before this, a session on another machine was
 * reported as a name nothing here had ever heard of.
 */
let home = '';
const ownHome = process.env.HOME;

const socket = (name: string): void => {
    const dir = join(home, '.cache', 'rho', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.sock`), '');
};

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rho-attach-'));
    process.env.HOME = home;
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    // A later test file reads the records of the machine it is running on, and
    // a HOME left pointing at a directory that has been removed is not that.
    process.env.HOME = ownHome;
});

describe('where a name is', () => {
    test('a name nothing has ever held is nowhere', () => {
        expect(attachable('never-used')).toBeNull();
    });

    test('a socket here is a session here', () => {
        socket('overnight');
        expect(attachable('overnight')).toEqual({ where: 'local', name: 'overnight', running: true, kept: null });
    });

    test('a name in the ledger is the machine the ledger says', () => {
        writeLedger({ hosts: new Map([['overnight', 'samuel@dev-box']]), worktrees: new Map() });
        expect(attachable('overnight')).toEqual({
            where: 'remote',
            name: 'overnight',
            host: 'samuel@dev-box',
            path: null,
        });
    });

    test("a project's session carries the worktree it was made in", () => {
        writeLedger({
            hosts: new Map(),
            worktrees: new Map([['rho-master', { host: 'samuel@dev-box', path: '/home/samuel/projects/rho' }]]),
        });
        expect(attachable('rho-master')).toEqual({
            where: 'remote',
            name: 'rho-master',
            host: 'samuel@dev-box',
            path: '/home/samuel/projects/rho',
        });
    });

    test('a socket here wins over the ledger, because drawing it needs no network', () => {
        socket('overnight');
        writeLedger({ hosts: new Map([['overnight', 'samuel@dev-box']]), worktrees: new Map() });
        expect(attachable('overnight')?.where).toBe('local');
    });

    test('a transcript here is the last reading, since starting it again is the expensive one', () => {
        remember('overnight', { file: join(home, 'a.jsonl'), cwd: home });
        writeLedger({ hosts: new Map([['overnight', 'samuel@dev-box']]), worktrees: new Map() });
        expect(attachable('overnight')?.where).toBe('remote');
        writeLedger({ hosts: new Map(), worktrees: new Map() });
        expect(attachable('overnight')).toEqual({
            where: 'local',
            name: 'overnight',
            running: false,
            kept: { file: join(home, 'a.jsonl'), cwd: home },
        });
    });
});

describe('the names that can be typed', () => {
    test('both records are offered, each said where it is, and no name twice', () => {
        socket('here-now');
        remember('here-now', { file: join(home, 'a.jsonl'), cwd: home });
        remember('stopped-here', { file: join(home, 'b.jsonl'), cwd: home });
        writeLedger({ hosts: new Map([['overnight', 'samuel@dev-box']]), worktrees: new Map() });
        expect(offers()).toEqual([
            { name: 'here-now', where: 'local', detail: 'running here' },
            { name: 'overnight', where: 'remote', detail: 'samuel@dev-box' },
            { name: 'stopped-here', where: 'local', detail: 'stopped here' },
        ]);
    });

    test('nothing held anywhere offers nothing', () => {
        expect(offers()).toEqual([]);
    });
});

describe('the ledger the two extensions share', () => {
    test('what one writes the other reads', () => {
        writeLedger({
            hosts: new Map([['overnight', 'samuel@dev-box']]),
            worktrees: new Map([['rho-master', { host: 'samuel@dev-box', path: '/home/samuel/p/rho' }]]),
        });
        const read = readLedger();
        expect(read.hosts.get('overnight')).toBe('samuel@dev-box');
        expect(read.worktrees.get('rho-master')).toEqual({ host: 'samuel@dev-box', path: '/home/samuel/p/rho' });
    });

    test('the flat name-to-host file the first version wrote is read as the sessions it was', () => {
        const where = join(home, '.cache', 'rho', 'remote');
        mkdirSync(where, { recursive: true });
        writeFileSync(join(where, 'sessions.json'), '{"overnight":"samuel@dev-box"}\n');
        expect(readLedger().hosts.get('overnight')).toBe('samuel@dev-box');
    });

    test('a damaged ledger is empty rather than half-read', () => {
        const where = join(home, '.cache', 'rho', 'remote');
        mkdirSync(where, { recursive: true });
        writeFileSync(join(where, 'sessions.json'), 'not json at all');
        expect(readLedger().hosts.size).toBe(0);
    });
});

describe('connecting to another machine', () => {
    test('what /remote publishes is what the flag calls', async () => {
        const called: string[] = [];
        publishConnect(async (_ctx, session, host) => {
            called.push(`${session}@${host ?? ''}`);
        });
        const connect = publishedConnect();
        expect(connect).not.toBeNull();
        await connect?.({} as never, 'overnight', 'samuel@dev-box');
        expect(called).toEqual(['overnight@samuel@dev-box']);
    });
});
