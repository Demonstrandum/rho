#!/usr/bin/env bun
/**
 * The command that runs on the always-on host.
 *
 *   rho-session serve <name> [cwd] [-- pi args...]   own a session
 *   rho-session attach <name>                        connect stdio to one
 *   rho-session list                                 what is running
 *   rho-session stop <name>
 *
 * `serve` detaches: it is started over ssh by a laptop that then goes away, so
 * a session tied to that ssh channel would die with it, which is the whole
 * thing this exists to prevent.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askToStop, attach, Broker, existing, facts, named, request, stop } from './broker';
import { entryCount, freePath, rehomed, sessionIdOf } from './transfer';
import { withoutModelFlags } from './pi-args';

const [verb, name, ...rest] = process.argv.slice(2);

const stateHome = (): string =>
    process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? tmpdir(), '.local', 'state');

const credentialDir = (name: string): string => join(stateHome(), 'rho', 'sessions', name);

/**
 * How long a session waits on a response that has stopped arriving.
 *
 * pi's own wait is five minutes. A machine behind NAT loses idle connections
 * without either end being told, so the next request goes into a socket nobody
 * is listening on and hangs for exactly that long before the retry that
 * succeeds: a turn measured here took 300.0 seconds from prompt to answer,
 * with the request sent and no byte ever returned.
 *
 * Thirty seconds is longer than any first token on these models and short
 * enough that a dead socket costs a pause rather than a coffee.
 */
const IDLE_TIMEOUT_MS = 30_000;

/** Where a runtime is, or null when it is not on PATH. */
const which = (name: string): string | null => {
    for (const dir of (process.env.PATH ?? '').split(':')) {
        if (dir === '') continue;
        const candidate = join(dir, name);
        try {
            if (existsSync(candidate)) return candidate;
        } catch {
            // an unreadable directory on PATH is not this one
        }
    }
    return null;
};

// The annotation is on the name rather than only on the arrow: typescript
// narrows after a call to a never-returning function only when the variable
// itself is declared to return never, and without it every `if (bad) die(...)`
// below leaves the value it just ruled out still possibly undefined.
const die: (message: string) => never = (message: string): never => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
};

if (verb === 'list') {
    const sessions = named();
    let alive = 0;
    for (const session of sessions) {
        if (await existing(session)) {
            alive += 1;
            // The directory too: a name alone cannot tell a project's worktree
            // from a home directory, and that is what a list is read for.
            process.stdout.write(`${session}\trunning\t${facts(session)?.cwd ?? ''}\n`);
            continue;
        }
        // A socket with nothing behind it is litter from a broker that was
        // killed: reporting it as a session means the next person tries to
        // attach to something that cannot answer.
        stop(session);
    }
    if (alive === 0) process.stdout.write('no sessions\n');
    process.exit(0);
}

/** Every session this machine holds, running or stopped. */
if (verb === 'all') {
    const dir = join(stateHome(), 'rho', 'sessions');
    const held = (() => {
        try {
            return readdirSync(dir);
        } catch {
            return [] as string[];
        }
    })();
    const names = [...new Set([...named(), ...held])].sort();
    for (const session of names) {
        const alive = await existing(session);
        const where = alive ? (facts(session)?.cwd ?? '') : '';
        process.stdout.write(`${session}\t${alive ? 'running' : 'stopped'}\t${where}\n`);
    }
    if (names.length === 0) process.stdout.write('no sessions\n');
    process.exit(0);
}

if (name === undefined) {
    die('usage: rho-session <serve|attach|list|all|state|busy|carry|adopt|stop|rename|forget|delete|relend> <name>');
}

/** What the agent in a running session says about itself. */
interface State {
    readonly sessionId?: string;
    readonly sessionFile?: string;
    readonly messageCount?: number;
    readonly isStreaming?: boolean;
}

const stateOf = async (name: string): Promise<State> => {
    const answer = await request(name, { type: 'get_state' });
    if (!answer.success) die(answer.error ?? `${name} would not say what it is doing`);
    return (answer.data ?? {}) as State;
};

/**
 * What this session is, for a machine deciding whether to hand it a
 * conversation.
 *
 * The identity and the message count come from the agent; the directory comes
 * from the broker, which is the only one that knows it, and the receiving side
 * needs it to rehome a session file it is sent.
 */
if (verb === 'state') {
    if (!(await existing(name))) die(`no session called ${name}`);
    const state = await stateOf(name);
    process.stdout.write(
        `${JSON.stringify({
            name,
            cwd: facts(name)?.cwd ?? '',
            sessionId: state.sessionId ?? null,
            sessionFile: state.sessionFile ?? null,
            messages: state.messageCount ?? 0,
            streaming: state.isStreaming === true,
        })}\n`,
    );
    process.exit(0);
}

/** Whether a turn is running, for anything that must not interrupt one. */
if (verb === 'busy') {
    if (!(await existing(name))) die(`no session called ${name}`);
    const state = await stateOf(name);
    process.stdout.write(state.isStreaming === true ? 'busy\n' : 'idle\n');
    process.exit(0);
}

/** This session's conversation, as the file that holds it. */
if (verb === 'carry') {
    if (!(await existing(name))) die(`no session called ${name}`);
    const state = await stateOf(name);
    if (state.sessionFile === undefined || state.sessionFile === '') die(`${name} keeps no session file`);
    process.stdout.write(readFileSync(state.sessionFile, 'utf8'));
    process.exit(0);
}

/**
 * A conversation from somewhere else, continued here.
 *
 * The file arrives on stdin, is rehomed to the directory this session works in
 * and written beside the session's own files under a name nothing is using,
 * and the agent is told to open it. From that point the two machines hold one
 * conversation with one identity, and carrying it back is the same operation
 * in the other direction.
 */
if (verb === 'adopt') {
    if (!(await existing(name))) die(`no session called ${name}`);
    const state = await stateOf(name);
    if (state.isStreaming === true) die(`${name} is mid-turn`);
    if (state.sessionFile === undefined || state.sessionFile === '') die(`${name} keeps no session file`);

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const carried = Buffer.concat(chunks).toString();
    if (carried.trim() === '') die('nothing to adopt');

    const cwd = facts(name)?.cwd ?? process.env.HOME ?? '/';
    const dir = join(state.sessionFile, '..');
    const id = sessionIdOf(carried);
    const path = freePath(dir, `${id ?? 'carried'}.jsonl`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, rehomed(carried, cwd));

    const answer = await request(name, { type: 'switch_session', sessionPath: path });
    if (!answer.success) die(answer.error ?? `${name} would not open ${path}`);
    // An extension on the far side may refuse a switch; that is an answer, not
    // an error, and the file it refused stays where it was written.
    if ((answer.data as { cancelled?: boolean } | undefined)?.cancelled === true) {
        die(`${name} refused the conversation it was sent`);
    }
    process.stdout.write(`${name} carries ${entryCount(carried)} entries from ${id ?? 'elsewhere'}\n`);
    process.exit(0);
}

if (verb === 'attach') {
    if (!(await existing(name))) die(`no session called ${name}`);
    await attach(name, process.stdin, process.stdout);
    process.exit(0);
}

if (verb === 'stop') {
    // Signals the broker, which ends the agent, drops every attached client
    // and removes the socket: its own close path, rather than a second way of
    // tearing a session down that could disagree with the first.
    // The pid file first, and the socket when there is no pid file: a session
    // whose note went missing is still a session, and it still answers.
    const bypid = stop(name);
    const asked = bypid ? true : await askToStop(name);
    if (asked) {
        process.stdout.write(`stopped ${name}\n`);
        process.exit(0);
    }
    // A session that is not running is not a session that does not exist: its
    // transcript is kept, and connecting starts it again where it left off.
    // Reporting both states as "no session called X" made a stop that had
    // already happened look like a name nobody recognised, and the four
    // sessions it was said about were all still listed by `all`.
    const kept = existsSync(join(stateHome(), 'rho', 'sessions', name));
    process.stdout.write(kept ? `${name} was already stopped\n` : `no session called ${name}\n`);
    process.exit(0);
}

/**
 * Credentials for the agent, read from stdin rather than taken from argv.
 *
 * The host has no login of its own, and it should not acquire one: a key in a
 * file on a machine is a key that outlives the session and gets backed up. The
 * laptop sends what it is logged in with down the ssh channel at start, the
 * session holds it in a directory of its own, and it dies with the session.
 * argv is not an option because `ps` shows it to every user on the box.
 *
 * What travels is auth.json and nothing else. Api keys from the laptop's shell
 * used to travel beside it, which gave the session a second identity to choose
 * from: a far side answering on an api key while the laptop answers on its
 * subscription is two accounts for one conversation, and the one it picked was
 * not the one paying for the rest.
 */
interface Lent {
    /** the contents of the laptop's auth.json, for OAuth logins and stored keys. */
    readonly auth: string | null;
}

/** The environment variables a provider will answer to instead of a stored login. */
const PROVIDER_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
    'XAI_API_KEY',
] as const;

const readFromStdin = async (): Promise<Lent> => {
    if (process.stdin.isTTY) return { auth: null };
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString().trim();
    if (text === '') return { auth: null };
    try {
        const parsed = JSON.parse(text) as { auth?: unknown };
        return { auth: typeof parsed.auth === 'string' ? parsed.auth : null };
    } catch {
        return { auth: null };
    }
};

/**
 * A config directory of this session's own, holding the laptop's credentials
 * and its transcript.
 *
 * An API key can travel as an environment variable; an OAuth login cannot,
 * because pi reads it from auth.json. Writing that into the host's own
 * ~/.pi/agent would leave the person's tokens on a machine they did not put
 * them on, and they would outlive the session and end up in backups.
 *
 * So the session gets its own directory, mode 0700, with everything else in
 * the real config directory symlinked in so settings, packages and extensions
 * still resolve. PI_CODING_AGENT_DIR points pi at it.
 *
 * It lives where state is kept rather than in a temporary directory, and
 * starting a session again keeps what is in it. It used to be under /tmp and
 * to be emptied on every start, so stopping a session and starting it under
 * the same name destroyed the conversation, and a reboot destroyed all of
 * them. Only the credentials are rewritten; `forget` is how a transcript goes.
 */
const lendCredentials = (auth: string, name: string): string => {
    const real = join(process.env.HOME ?? '/tmp', '.pi', 'agent');
    const dir = credentialDir(name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    try {
        for (const entry of readdirSync(real)) {
            // auth.json is written here, and sessions is this session's own.
            if (entry === 'auth.json' || entry === 'sessions') continue;
            try {
                symlinkSync(join(real, entry), join(dir, entry));
            } catch {
                // an entry that cannot be linked is one pi will do without, and
                // a link that is already there is the one we would have made
            }
        }
    } catch {
        // no config directory on the far side: the credentials alone will do
    }

    writeFileSync(join(dir, 'auth.json'), auth, { mode: 0o600 });

    /**
     * rho, when it was sent, as the package this session loads.
     *
     * Written rather than symlinked from the host's own config: the host may
     * have no pi config at all, and what the agent loads here should be the
     * rho that was sent rather than whatever that machine happens to hold.
     */
    const rho = process.env.RHO_RHO_DIR;
    rmSync(join(dir, 'settings.json'), { force: true });
    writeFileSync(
        join(dir, 'settings.json'),
        `${JSON.stringify({ ...(rho === undefined || rho === '' ? {} : { packages: [rho] }), httpIdleTimeoutMs: IDLE_TIMEOUT_MS }, null, 2)}\n`,
        { mode: 0o600 },
    );
    return dir;
};

/**
 * Credentials again, for a session that is already running.
 *
 * An OAuth token lasts hours and its refresh token is single use: the laptop
 * refreshing its own login invalidates the copy the far side is holding, and
 * the next turn there comes back empty with the refusal buried in the message.
 * pi rereads auth.json when it changes, so handing it a newer one is enough --
 * no restart, and the session keeps its history.
 */
/**
 * A new name for a session, transcript and all.
 *
 * Only while it is stopped: the name is in the socket, the pid file and the
 * agent's own arguments, and renaming those under a running session would
 * leave a client talking to a socket nobody answers.
 */
if (verb === 'rename') {
    const to = rest[0];
    if (to === undefined) die('usage: rename <old> <new>');
    if (!/^[A-Za-z0-9._-]+$/.test(to)) die(`${to} is not a name a session can have`);
    if (await existing(name)) die(`${name} is running: stop it before renaming it`);
    const from = credentialDir(name);
    const onto = credentialDir(to);
    if (!existsSync(from)) die(`no session called ${name}`);
    if (existsSync(onto)) die(`${to} already exists`);
    renameSync(from, onto);
    process.stdout.write(`${name} is now ${to}\n`);
    process.exit(0);
}

/**
 * Stop it if it is running, wait for it to go, then forget it.
 *
 * `stop` signals the broker and returns, so the socket still answers for a
 * moment afterwards and a `forget` sent straight after it is refused for a
 * session that is on its way out. Doing both here is one ssh round trip rather
 * than a poll from the other machine, and the wait is where the race is paid.
 */
if (verb === 'delete') {
    const dir = credentialDir(name);
    if (!existsSync(dir)) die(`no session called ${name}`);
    if (await existing(name)) {
        if (!stop(name)) await askToStop(name);
        const until = Date.now() + 10_000;
        while (Date.now() < until && (await existing(name))) {
            await new Promise((settle) => setTimeout(settle, 100));
        }
        if (await existing(name)) die(`${name} would not stop, so it is still here`);
    }
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`deleted ${name}\n`);
    process.exit(0);
}

/** The transcript and the credentials, gone. This is the destructive one. */
if (verb === 'forget') {
    if (await existing(name)) die(`${name} is running: stop it before forgetting it`);
    const dir = credentialDir(name);
    if (!existsSync(dir)) die(`no session called ${name}`);
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`forgot ${name}\n`);
    process.exit(0);
}

if (verb === 'relend') {
    const lent = await readFromStdin();
    if (lent.auth === null) die('nothing to lend');
    const dir = credentialDir(name);
    if (!existsSync(dir)) die(`${name} has no credentials of its own to replace`);
    writeFileSync(join(dir, 'auth.json'), lent.auth ?? '{}', { mode: 0o600 });
    // The wait on a response that stopped arriving, refreshed with the
    // credentials, so a session made before this setting existed picks it up
    // the next time it starts.
    try {
        const held: Record<string, unknown> = existsSync(join(dir, 'settings.json'))
            ? (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>)
            : {};
        held.httpIdleTimeoutMs = IDLE_TIMEOUT_MS;
        writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(held, null, 2)}\n`, { mode: 0o600 });
    } catch {
        // settings that cannot be read are settings this does not rewrite
    }
    process.stdout.write(`${name} has fresh credentials\n`);
    process.exit(0);
}

if (verb === 'serve') {
    if (await existing(name)) die(`${name} is already running`);

    const cwd = rest[0] !== undefined && !rest[0].startsWith('-') ? rest[0] : process.env.HOME ?? '/';
    // Checked here, where the directory is named, because a spawn with a
    // working directory that does not exist reports ENOENT against the binary:
    // asking for a session in a directory that is not there produced a stack
    // trace about bun not existing, which it did.
    if (!existsSync(cwd)) die(`${cwd} does not exist on this machine`);
    const piArgs = rest.includes('--') ? rest.slice(rest.indexOf('--') + 1) : [];

    /**
     * The interface that is handing this session over, if one is.
     *
     * Detaching locally gives a running session to a daemon by its session
     * file, and two pi processes appending to one file would interleave two
     * conversations into it. The daemon waits for the interface to go before
     * it starts, so the file has one writer throughout.
     */
    const afterFlag = rest.indexOf('--after-pid');
    const afterPid = afterFlag === -1 ? undefined : Number.parseInt(rest[afterFlag + 1] ?? '', 10);
    if (afterFlag !== -1 && (afterPid === undefined || !Number.isFinite(afterPid))) die('--after-pid needs a pid');
    const gone = (pid: number): boolean => {
        try {
            process.kill(pid, 0);
            return false;
        } catch {
            return true;
        }
    };

    // Detach unless asked not to: `ssh host rho-session serve` returns as soon
    // as the session is up, and the session stays.
    if (process.env.RHO_SESSION_FOREGROUND !== '1') {
        const lent = await readFromStdin();
        const credentials = lent.auth === null ? {} : { PI_CODING_AGENT_DIR: lendCredentials(lent.auth, name) };
        // A login was lent, so it is the one this session answers with. A key
        // sitting in the host's own environment is a second identity nobody
        // chose, and pi picking it would bill an account the person at the
        // interface is not looking at. Nothing is stripped when no login was
        // lent, because then the environment is all there is.
        const withoutHostKeys: Record<string, string | undefined> =
            lent.auth === null ? {} : Object.fromEntries(PROVIDER_KEYS.map((key) => [key, undefined]));
        const child = spawn(process.execPath, [import.meta.filename, 'serve', name, ...rest], {
            cwd,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, ...withoutHostKeys, ...credentials, RHO_SESSION_FOREGROUND: '1' },
        });
        // A spawn that cannot start says so once, in a sentence, rather than
        // as a stack trace through node's child_process.
        child.on('error', (trouble: Error) => die(`could not start ${name}: ${trouble.message}`));
        child.unref();
        // A session waiting for an interface to exit cannot have a socket yet,
        // and that interface is usually the process asking for it, so waiting
        // here would wait for ourselves.
        if (afterPid !== undefined) {
            process.stdout.write(`${name} starts in ${cwd} when this interface exits\n`);
            process.exit(0);
        }
        // Wait for the socket rather than claiming success: a session that
        // failed to start should say so while the laptop is still listening.
        for (let waited = 0; waited < 10_000; waited += 200) {
            if (await existing(name)) {
                process.stdout.write(`${name} is running in ${cwd}\n`);
                process.exit(0);
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        die(`${name} did not start`);
    }

    // Nothing is read or written until the interface has let the file go.
    if (afterPid !== undefined) {
        for (let waited = 0; !gone(afterPid); waited += 100) {
            if (waited > 120_000) die(`the interface (${afterPid}) did not exit, so ${name} was not started`);
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    // A session that has been here before picks up where it stopped: its
            // transcript is in its own directory, and stopping is not forgetting.
    const kept = existsSync(join(credentialDir(name), 'sessions'));
    const resume = kept ? ['--continue'] : [];

    // The model the interface handed over is for a session that has none: one
    // being continued keeps what it was left on. See lib/remote/pi-args.ts.
    const chosen = kept ? withoutModelFlags(piArgs) : piArgs;

    /**
     * The pi to run: the laptop's, when it has been sent, and the host's
     * otherwise.
     *
     * A host's own pi is whatever was installed there -- dev-box had
     * 0.84.3 against a laptop on 0.85.1 -- and a host that has never had pi
     * could not hold a session at all. RHO_PI_CLI names a copy of the laptop's
     * own, so both machines run the same agent.
     */
    const lentPi = process.env.RHO_PI_CLI;
    const usable = lentPi !== undefined && lentPi !== '' && existsSync(lentPi);
    // node before bun for the lent pi: a host's bun can be older than the pi
    // it is being asked to run, and dev-box's 1.3.13 dies inside undici on
    // pi 0.85.1 with an error about markAsUncloneable. node is what the
    // package was installed for.
    // node unless a bun was sent for this session.
    //
    // rho arrives here already built to javascript, so node can load it, and a
    // host's own bun can be older than the pi it is being asked to run:
    // dev-box's 1.3.13 dies inside undici on pi 0.85.1.
    const sentBun = process.env.RHO_BUN;
    const runtime =
        sentBun !== undefined && sentBun !== '' && (sentBun === 'bun' || existsSync(sentBun))
            ? sentBun
            : (which('node') ?? which('bun') ?? process.execPath);
    const [command, head] = usable ? [runtime, [lentPi as string]] : ['pi', [] as string[]];
    const broker = new Broker(name, command, [...head, '--mode', 'rpc', '--name', name, ...resume, ...chosen], cwd);
    // The session is the agent: when it goes, this process has nothing left to
    // hold and no reason to stay resident.
    broker.onEnded = () => process.exit(0);
    // Hours rather than minutes: a session is meant to be left and come back
    // to, and the cost of starting one again is seconds.
    const idleHours = Number.parseFloat(process.env.RHO_SESSION_IDLE_HOURS ?? '6');
    if (Number.isFinite(idleHours) && idleHours > 0) broker.retireAfter(idleHours * 3_600_000);
    broker.listen();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => broker.stop());
    // Nothing else to do: the broker owns the process and the socket.
    await new Promise(() => {});
}

die(`unknown command: ${verb}`);
