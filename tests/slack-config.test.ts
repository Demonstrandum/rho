import { describe, expect, test, beforeAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// the store resolves its directory at import time, so the override goes in
// before the module is loaded.
const DIR = mkdtempSync(join(tmpdir(), 'rho-slack-'));
process.env.RHO_SLACK_DIR = DIR;

type Store = typeof import('../extensions/lib/slack-config');
let store: Store;

beforeAll(async () => {
    store = await import('../extensions/lib/slack-config');
});

describe('app names', () => {
    test('a name is trimmed and lowercased, so one app has one filename', () => {
        expect(store.checkName('Code-Bot')).toEqual({ ok: true, name: 'code-bot' });
        expect(store.checkName('  ops.2 ')).toEqual({ ok: true, name: 'ops.2' });
    });

    test('a name that would escape the store is refused', () => {
        for (const bad of ['../evil', 'a/b', '', '.hidden', 'with space']) {
            expect(store.checkName(bad).ok).toBe(false);
        }
    });
});

describe('the app store', () => {
    test('an app round-trips, and an unknown one is not an error', () => {
        expect(store.readApp('absent')).toEqual({ kind: 'unknown' });
        expect(store.writeApp('code-bot', { app: 'xapp-1', bot: 'xoxb-1' })).toBe(true);
        expect(store.readApp('code-bot')).toEqual({ kind: 'ok', tokens: { app: 'xapp-1', bot: 'xoxb-1' } });
        expect(store.listApps()).toContain('code-bot');
    });

    test('a file missing a token reads as unreadable rather than as tokens', () => {
        mkdirSync(join(DIR, 'apps'), { recursive: true });
        writeFileSync(join(DIR, 'apps', 'half.json'), JSON.stringify({ app: 'xapp-1' }));
        expect(store.readApp('half').kind).toBe('unreadable');
    });

    test('dropping an app removes it and its lock', () => {
        store.writeApp('temporary', { app: 'xapp-2', bot: 'xoxb-2' });
        store.takeLock('temporary', 'session-1', '/tmp');
        expect(store.removeApp('temporary')).toBe(true);
        expect(store.readApp('temporary')).toEqual({ kind: 'unknown' });
        expect(store.readLock('temporary')).toEqual({ kind: 'free' });
    });
});

describe('the per-app lock', () => {
    test('a lock this process holds reads as alive', () => {
        store.takeLock('code-bot', 'session-1', '/work');
        const held = store.readLock('code-bot');
        expect(held.kind).toBe('held');
        if (held.kind !== 'held') return;
        expect(held.alive).toBe(true);
        expect(held.lock).toMatchObject({ app: 'code-bot', sessionId: 'session-1', cwd: '/work', pid: process.pid });
    });

    test('a lock whose process is gone reads as stale, so it can be taken over', () => {
        writeFileSync(
            join(DIR, 'apps', 'dead.lock'),
            JSON.stringify({ app: 'dead', sessionId: 'gone', pid: 0x7fffffff, since: '2026-01-01T00:00:00Z', cwd: '/x' }),
        );
        const held = store.readLock('dead');
        expect(held.kind).toBe('held');
        if (held.kind !== 'held') return;
        expect(held.alive).toBe(false);
    });

    test('releasing another session\'s lock does nothing', () => {
        store.takeLock('code-bot', 'session-1', '/work');
        store.releaseLock('code-bot', 'session-2');
        expect(store.readLock('code-bot').kind).toBe('held');
        store.releaseLock('code-bot', 'session-1');
        expect(store.readLock('code-bot')).toEqual({ kind: 'free' });
    });
});

describe('the manifest', () => {
    test('it carries every scope the extension calls with', () => {
        const yaml = store.manifestYaml('code-bot');
        const used = [
            'chat:write', // answering, and the typing status
            'reactions:write', // the read mark
            'files:read', // an incoming attachment
            'files:write', // an outgoing one
            'im:history', // reading a DM, and the catch-up
            'im:read',
            'users:read', // a name instead of an id
            'app_mentions:read', // the mention guard in a channel
        ];
        for (const scope of used) expect(yaml).toContain(scope);
        expect(yaml).toContain('socket_mode_enabled: true');
        expect(yaml).toContain('message.im');
    });

    test('a channel event is subscribed, since the guard and not the manifest decides what is answered', () => {
        const yaml = store.manifestYaml('code-bot');
        for (const event of ['message.mpim', 'message.channels', 'message.groups', 'app_mention']) {
            expect(yaml).toContain(event);
        }
    });

    test('the messages tab is on and writable, or the app cannot be written to at all', () => {
        const yaml = store.manifestYaml('code-bot');
        expect(yaml).toContain('messages_tab_enabled: true');
        expect(yaml).toContain('messages_tab_read_only_enabled: false');
    });

    test('the app name reaches the display name, which is what slack prints in the status line', () => {
        expect(store.manifestYaml('code-bot')).toContain('display_name: code-bot');
    });

    test('the create-app link carries the manifest as a query parameter', () => {
        const link = new URL(store.createAppLink('code-bot'));
        expect(link.searchParams.get('new_app')).toBe('1');
        expect(link.searchParams.get('manifest_yaml')).toBe(store.manifestYaml('code-bot'));
    });
});
