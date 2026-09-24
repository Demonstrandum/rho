// the store of Slack apps, and the lock that keeps one app to one session.
//
// credentials belong to an app, and an app is what a session attaches to, so
// there is no single set of tokens to keep. the store holds as many as you
// like, each under a name, and `/slack code-bot` attaches this session to that
// one. nothing is pasted into a conversation: `/slack add` prompts for the two
// tokens through the UI and writes them to a file with mode 0600.
//
// the lock is per app, not per machine. Slack sends each payload to an
// arbitrary one of an app's open Socket Mode connections, so two sessions on
// ONE app split the incoming DMs at random. two sessions on TWO apps are
// independent, which is the arrangement this store exists to make cheap.
//
// in a subdirectory so extension auto-discovery (top-level *.ts only) does not
// load it as an extension.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import envPaths from 'env-paths';

const paths = envPaths('rho', { suffix: '' });

// RHO_SLACK_DIR exists for the tests, which must not write an app or a lock
// into the config directory of the machine running them.
export const SLACK_DIR = process.env.RHO_SLACK_DIR ?? join(paths.config, 'slack');
const APPS_DIR = join(SLACK_DIR, 'apps');

/**
 * An app's name in the store, which is also its filename, so it is restricted
 * to what is safe as one and unambiguous on a case-insensitive filesystem.
 */
export type AppName = string;

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type NameCheck = { readonly ok: true; readonly name: AppName } | { readonly ok: false; readonly why: string };

export function checkName(raw: string): NameCheck {
    const name = raw.trim().toLowerCase();
    if (name === '') return { ok: false, why: 'a name is required' };
    if (!NAME.test(name)) {
        return { ok: false, why: 'a name is lower case letters, digits, dot, dash, or underscore, up to 64' };
    }
    return { ok: true, name };
}

export interface SlackTokens {
    /** xapp-, app-level, connections:write. opens the Socket Mode connection. */
    readonly app: string;
    /** xoxb-, bot user OAuth. every Web API call. */
    readonly bot: string;
}

/** the prefix Slack gives each token, which is enough to catch the two being swapped. */
export const TOKEN_PREFIX = { app: 'xapp-', bot: 'xoxb-' } as const;

export type TokenKind = keyof typeof TOKEN_PREFIX;

export type AppRead =
    | { readonly kind: 'ok'; readonly tokens: SlackTokens }
    | { readonly kind: 'unknown' }
    | { readonly kind: 'unreadable'; readonly why: string };

const appFile = (name: AppName): string => join(APPS_DIR, `${name}.json`);
const lockFile = (name: AppName): string => join(APPS_DIR, `${name}.lock`);

const parseTokens = (raw: unknown): SlackTokens | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.app !== 'string' || typeof o.bot !== 'string') return null;
    if (o.app === '' || o.bot === '') return null;
    return { app: o.app, bot: o.bot };
};

export function listApps(): readonly AppName[] {
    let files: string[];
    try {
        files = readdirSync(APPS_DIR);
    } catch {
        return [];
    }
    return files
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -'.json'.length))
        .sort();
}

export function readApp(name: AppName): AppRead {
    const path = appFile(name);
    if (!existsSync(path)) return { kind: 'unknown' };
    let tokens: SlackTokens | null;
    try {
        tokens = parseTokens(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    } catch (error) {
        return { kind: 'unreadable', why: (error as Error).message };
    }
    if (tokens === null) return { kind: 'unreadable', why: 'no app and bot token in the file' };
    return { kind: 'ok', tokens };
}

/** written through a temp file and a rename, so an interrupted write leaves the previous app intact. */
export function writeApp(name: AppName, tokens: SlackTokens): boolean {
    const path = appFile(name);
    const temp = `${path}.${process.pid}.tmp`;
    try {
        mkdirSync(APPS_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(temp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
        renameSync(temp, path);
        return true;
    } catch {
        try {
            rmSync(temp, { force: true });
        } catch {
            // nothing left to do; the app is simply not stored.
        }
        return false;
    }
}

export function removeApp(name: AppName): boolean {
    try {
        rmSync(appFile(name), { force: true });
        rmSync(lockFile(name), { force: true });
        return true;
    } catch {
        return false;
    }
}

/**
 * Which session holds this app's socket. `pid` is what makes a stale lock
 * recognisable: a session that dies without releasing leaves the file behind,
 * and the next session can see that nothing runs under that pid.
 */
export interface ConnectionLock {
    readonly app: AppName;
    readonly sessionId: string;
    readonly pid: number;
    /** ISO 8601, for the status line. */
    readonly since: string;
    /** the working directory of the holding session, so the status line says where it is. */
    readonly cwd: string;
}

export type LockState =
    | { readonly kind: 'free' }
    | { readonly kind: 'held'; readonly lock: ConnectionLock; readonly alive: boolean };

const parseLock = (raw: unknown): ConnectionLock | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.app !== 'string' || typeof o.sessionId !== 'string') return null;
    if (typeof o.pid !== 'number' || typeof o.since !== 'string' || typeof o.cwd !== 'string') return null;
    return { app: o.app, sessionId: o.sessionId, pid: o.pid, since: o.since, cwd: o.cwd };
};

/** signal 0 tests for the process without touching it. */
const running = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means a process exists and is not ours to signal.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

export function readLock(name: AppName): LockState {
    const path = lockFile(name);
    if (!existsSync(path)) return { kind: 'free' };
    let lock: ConnectionLock | null;
    try {
        lock = parseLock(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    } catch {
        lock = null;
    }
    if (lock === null) return { kind: 'free' };
    return { kind: 'held', lock, alive: running(lock.pid) };
}

export function takeLock(name: AppName, sessionId: string, cwd: string): ConnectionLock {
    const lock: ConnectionLock = {
        app: name,
        sessionId,
        pid: process.pid,
        since: new Date().toISOString(),
        cwd,
    };
    mkdirSync(APPS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(lockFile(name), `${JSON.stringify(lock)}\n`, { mode: 0o600 });
    return lock;
}

/** a no-op when the lock belongs to another session, so an exiting session cannot free another's socket. */
export function releaseLock(name: AppName, sessionId: string): void {
    const state = readLock(name);
    if (state.kind === 'free' || state.lock.sessionId !== sessionId) return;
    try {
        rmSync(lockFile(name), { force: true });
    } catch {
        // a stale file is read back as a dead lock and taken over.
    }
}

/** every app in the store with the state of its lock, for the status line and for completions. */
export interface AppSummary {
    readonly name: AppName;
    readonly lock: LockState;
}

export function summary(): readonly AppSummary[] {
    return listApps().map((name) => ({ name, lock: readLock(name) }));
}

/**
 * The app definition, as Slack's manifest schema.
 *
 * The scopes are granted once, at creation, because adding one later means
 * reinstalling the app to every workspace it is in. They cover what the
 * extension does now (answer, react, read a DM, catch up, name a user) and
 * what it can be asked to do without a second setup: files in both
 * directions, group DMs, and channels where the app is mentioned.
 *
 * A scope is a permission, not an action. The events decide what actually
 * arrives, and the mention guard in slack.ts decides what is answered: a
 * message in a channel reaches the session only when it names the app.
 *
 * Socket Mode carries the events, so there is no request URL to configure.
 *
 * `name` is substituted, because the app name is what Slack prints in front of
 * the typing status: "code-bot is thinking...".
 */
export function manifestYaml(name: AppName): string {
    return `display_information:
  name: ${name}
  description: a pi session, reachable from Slack
features:
  app_home:
    home_tab_enabled: false
    # without these two the app's DM is read-only, and Slack puts "Sending
    # messages to this app has been turned off" where the input box goes.
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: ${name}
    always_online: false
oauth_config:
  scopes:
    bot:
      # answering, and the typing status
      - chat:write
      - chat:write.public
      # the read mark, and reading one back
      - reactions:write
      - reactions:read
      # files in both directions
      - files:read
      - files:write
      # direct messages, which is where a session is normally reached
      - im:history
      - im:read
      - im:write
      # group direct messages
      - mpim:history
      - mpim:read
      - mpim:write
      # channels, public and private, where the app is a member and is named
      - app_mentions:read
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      # a name instead of U09L8EEPUTC
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - message.im
      - message.mpim
      # a channel message arrives only where the app is a member, and is
      # answered only when it names the app. see the mention guard in slack.ts.
      - message.channels
      - message.groups
      - app_mention
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;
}

/**
 * Opens Slack's create-app dialog with the manifest already filled in, which
 * leaves generating the two tokens as the only manual step.
 */
export function createAppLink(name: AppName): string {
    return `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(manifestYaml(name))}`;
}
