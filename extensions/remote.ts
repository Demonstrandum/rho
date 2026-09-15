/**
 * /remote — the session runs on the always-on host, the laptop only looks at it.
 *
 *   /remote create work samuel@dev-box        start a named session there
 *   /remote create work samuel@dev-box:/srv   ... in a directory
 *   /remote connect work                          attach this pi to it
 *   /remote list                                  what is running there
 *   /remote stop work
 *
 * `create` does the ssh part, so the person never types ssh: it ships the
 * session runner to the host the same way the executor is shipped, starts a
 * detached broker, and returns as soon as the session is up. `connect` then
 * hands this terminal over to it.
 *
 * The laptop holds nothing. Close it, open it tomorrow, connect again, and the
 * session is where it was, because the agent was never running here.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { addressName, parseAddress, sshTarget } from './lib/remote/address';
import { browse } from './lib/picker';
import { controlPath } from './lib/remote/agent-tag';
import { shorthandFor, takeVerb } from './lib/shorthand';
import { completeLastWord, lastWord } from './lib/complete-words';
import { troubleWith } from './lib/remote/advice';
import { agentTrouble, describeAgentTrouble } from './lib/remote/ssh-agent';
import { branchSlug, parseProjectRequest, repoName, sessionName } from './lib/remote/naming';
import { projectPlan } from './lib/remote/project';

/** What /remote can be asked to do. A word is matched against these. */
const VERBS = ['create', 'connect', 'project', 'list', 'manage', 'stop'] as const;

const CACHE = join(process.env.HOME ?? '/tmp', '.cache', 'rho', 'remote');
const REMOTE_DIR = '.cache/rho/remote';
// Same reason as deploy.ts: import.meta.dir is a data URL when pi loads this
// from a bundle, and every read then fails with ENAMETOOLONG.
/** rho's own directory, for the client that lives beside this file. */
const rhoRoot = (): string => join(remoteDir(), '..', '..', '..');

const remoteDir = (): string => {
    const candidates: string[] = [];
    const fromEnv = process.env.RHO_REMOTE_DIR;
    if (fromEnv !== undefined && fromEnv !== '') candidates.push(fromEnv);
    try {
        const url = import.meta.url;
        if (url.startsWith('file:')) candidates.push(join(dirname(fileURLToPath(url)), 'lib', 'remote'));
    } catch {
        // not a file URL
    }
    const dir = import.meta.dir;
    if (typeof dir === 'string' && dir.length < 4096 && dir.startsWith('/')) {
        candidates.push(join(dir, 'lib', 'remote'));
    }
    const home = process.env.HOME;
    if (home !== undefined) candidates.push(join(home, 'Code', 'rho', 'extensions', 'lib', 'remote'));

    for (const candidate of candidates) {
        if (existsSync(join(candidate, 'session-main.ts'))) return candidate;
    }
    throw new Error('cannot find session-main.ts; set RHO_REMOTE_DIR to the directory holding it');
};

/**
 * The same flags the executor's connections use.
 *
 * Without ConnectTimeout an unreachable host blocks the command handler, and
 * pi has no input while a handler runs: the person sees the field clear and
 * nothing else. Without ClearAllForwardings a port forward in the person's ssh
 * config prints its complaint into the output being parsed.
 */
const SSH_FLAGS = [
    // A node allocated a minute ago has a host key nothing has seen before,
    // and a command run by a tool has no terminal to answer a prompt on: the
    // prompt appeared in the person's session instead, under whatever they
    // were reading at the time. accept-new trusts an unknown host once and
    // still refuses one whose key has changed, which is the case that matters.
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'BatchMode=yes',
    // A handshake to this fleet costs seconds, so it is paid once and shared:
    // the second call down the same connection is a tenth of the first.
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath(CACHE)}`,
    '-o',
    'ControlPersist=10m',
];

const run = (
    command: string,
    args: readonly string[],
    input?: Uint8Array,
): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((settle) => {
        const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            err += chunk.toString();
        });
        child.on('error', (error) => settle({ code: null, out, err: error.message }));
        child.on('close', (code) => settle({ code, out, err }));
        if (input !== undefined) child.stdin.write(input);
        child.stdin.end();
    });

/**
 * The session runner as one executable, for a machine with no runtime at all.
 *
 * Cached by a hash of the source rather than of the binary: two compilations
 * of the same source are not byte-identical, and a key that changes every time
 * is not a cache.
 */
async function compile(platform: 'linux-x64' | 'linux-arm64'): Promise<{ path: string; hash: string }> {
    const here = remoteDir();
    const hash = createHash('sha256')
        .update(readFileSync(join(here, 'session-main.ts')))
        .update(readFileSync(join(here, 'broker.ts')))
        .update(readFileSync(join(here, 'protocol.ts')))
        .update(platform)
        .digest('hex')
        .slice(0, 16);
    mkdirSync(CACHE, { recursive: true });
    const out = join(CACHE, `session-${platform}-${hash}`);
    try {
        if (statSync(out).size > 0) return { path: out, hash };
    } catch {
        // not compiled yet
    }
    const built = await run('bun', [
        'build',
        join(here, 'session-main.ts'),
        '--compile',
        `--target=bun-${platform}`,
        '--outfile',
        out,
    ]);
    if (built.code !== 0) throw new Error(`could not compile the session runner: ${built.err || built.out}`);
    return { path: out, hash };
}

/** The session runner as one file, cached by a hash of its source. */
async function bundle(): Promise<{ path: string; hash: string }> {
    const here = remoteDir();
    const hash = createHash('sha256')
        .update(readFileSync(join(here, 'session-main.ts')))
        .update(readFileSync(join(here, 'broker.ts')))
        .update(readFileSync(join(here, 'protocol.ts')))
        .digest('hex')
        .slice(0, 16);
    mkdirSync(CACHE, { recursive: true });
    const out = join(CACHE, `session-${hash}.js`);
    try {
        if (statSync(out).size > 0) return { path: out, hash };
    } catch {
        // not bundled yet
    }
    const built = await run('bun', ['build', join(remoteDir(), 'session-main.ts'), '--target=node', '--outfile', out]);
    if (built.code !== 0) throw new Error(`could not bundle the session runner: ${built.err || built.out}`);
    return { path: out, hash };
}

/**
 * Put the runner on the host if it is not there, and say how to start it.
 *
 * No setup on the far side, on any account: a machine with bun or node takes a
 * small bundle, and a machine with neither takes a compiled executable, the
 * same fallback the executor uses. Refusing a bare host was asking the person
 * to install a runtime first, which is the thing this is supposed to avoid.
 */
/**
 * The name the client uses to reach the runner.
 *
 * create() installs it by content hash, so two versions never collide; the
 * client needs one name it can count on, so the installed file is also linked
 * here. A link rather than a copy: the same bytes, one place to look.
 */
export const RUNNER_LINK = `${REMOTE_DIR}/session-runner.js`;

async function place(host: string, say: (note: string) => void): Promise<string> {
    const probe = await run('ssh', [...SSH_FLAGS, host, 'command -v bun || command -v node || true; echo ---; uname -m']);
    if (probe.code !== 0) throw new Error(`cannot reach ${host}: ${probe.err.trim() || 'ssh failed'}`);
    const [runtimeLine = '', machineLine = ''] = probe.out.split('---');
    const runtime = runtimeLine.trim().split('\n')[0]?.trim();
    const arm = machineLine.trim().startsWith('aarch64') || machineLine.trim().startsWith('arm64');

    if (runtime === undefined || runtime === '') {
        say(`compiling the session runner for ${host}, which has no runtime`);
        const { path, hash } = await compile(arm ? 'linux-arm64' : 'linux-x64');
        const remote = `${REMOTE_DIR}/session-${hash}`;
        const present = await run('ssh', [...SSH_FLAGS, host, `test -x ${remote} && echo yes || echo no`]);
        if (present.out.trim() !== 'yes') {
            say(`copying the session runner to ${host}`);
            const sent = await run(
                'ssh',
                [host, `mkdir -p ${REMOTE_DIR} && cat > ${remote}.part && chmod +x ${remote}.part && mv ${remote}.part ${remote}`],
                readFileSync(path),
            );
            if (sent.code !== 0) throw new Error(`could not copy the session runner: ${sent.err.trim()}`);
        }
        return `./${remote}`;
    }

    const { path, hash } = await bundle();
    const remote = `${REMOTE_DIR}/session-${hash}.js`;
    const present = await run('ssh', [...SSH_FLAGS, host, `test -s ${remote} && echo yes || echo no`]);
    if (present.out.trim() !== 'yes') {
        say(`copying the session runner to ${host}`);
        const sent = await run(
            'ssh',
            [host, `mkdir -p ${REMOTE_DIR} && cat > ${remote}.part && mv ${remote}.part ${remote}`],
            readFileSync(path),
        );
        if (sent.code !== 0) throw new Error(`could not copy the session runner: ${sent.err.trim()}`);
    }
    return `${runtime} ${remote}`;
}

/** Where the agent's own pi is kept on a host, one directory per version. */
const PI_DIR = '.cache/rho/pi';
/** Where a bun new enough to run it is kept, when the host's own is not. */
const BUN_DIR = '.cache/rho/bun';
/** Where rho itself is kept, one directory per revision of its source. */
const RHO_DIR = '.cache/rho/agent';

/**
 * The oldest bun that can run the pi this machine is running.
 *
 * dev-box's 1.3.13 dies inside undici on pi 0.85.1, with an error about
 * markAsUncloneable, and rho's extensions are typescript, which means bun
 * rather than node has to be the one that loads them.
 */
const MIN_BUN = [1, 4, 0] as const;

const newEnough = (version: string): boolean => {
    const parts = version.trim().split('.').map((piece) => Number.parseInt(piece, 10));
    for (const [index, least] of MIN_BUN.entries()) {
        const found = parts[index] ?? 0;
        if (found > least) return true;
        if (found < least) return false;
    }
    return true;
};

/** The version of pi this machine is running. */
function localPiVersion(): string | null {
    try {
        const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
        const manifest = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
            version?: string;
        };
        return manifest.version ?? null;
    } catch {
        // pi is not resolvable from here: the host's own is what there is.
        return null;
    }
}

/**
 * Where a project lives on the host. One clone, many worktrees, because that
 * is what a session per branch needs: a worktree is a directory sharing one
 * object store, so ten branches cost one clone rather than ten.
 *
 *   ~/projects/<project>/checkout/<repo>     the clone
 *   ~/projects/<project>/worktrees/<branch>  where a session works
 */
const PROJECTS = 'projects';

/**
 * A turning status line for work that takes a while.
 *
 * pi takes the input field away while a command handler runs, so a slow step
 * with nothing on screen is indistinguishable from a session that has hung.
 * Starting a session on a small machine is slow for a reason that is not ours:
 * pi's own startup there is twenty seconds, so the person is told what is
 * happening and how long it has been happening for.
 */
const FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

interface Progress {
    say(step: string): void;
    done(): void;
}

const progress = (ctx: { ui: { setStatus: (key: string, text?: string) => void } }): Progress => {
    const started = Date.now();
    let step = 'working';
    let frame = 0;
    const tick = setInterval(() => {
        frame = (frame + 1) % FRAMES.length;
        const seconds = Math.round((Date.now() - started) / 1000);
        ctx.ui.setStatus('rho-remote', `${FRAMES[frame]} ${step}\u2026 ${seconds}s`);
    }, 120);
    tick.unref?.();
    return {
        say(next: string) {
            step = next;
        },
        done() {
            clearInterval(tick);
            ctx.ui.setStatus('rho-remote', undefined);
        },
    };
};

export default function (pi: ExtensionAPI) {
    /** Where each named session lives, so connect and stop need only the name. */
    /**
     * Which machine each session is on, remembered across pi processes.
     *
     * A session outlives the pi that started it -- that is the point of it --
     * so the next pi has to be told where it is, or connecting to a session
     * created five minutes ago in another window fails with "I do not know
     * which host". It is a small file beside the runner cache rather than
     * session state, because it is a fact about the machine, not about a
     * conversation.
     */
    const ledger = join(homedir(), REMOTE_DIR, 'sessions.json');

    /** A project's worktree, so connecting to it starts the session in the right directory. */
    interface Worktree {
        readonly host: string;
        readonly path: string;
    }

    interface Ledger {
        readonly sessions: Record<string, string>;
        readonly projects: Record<string, Worktree>;
    }

    const readLedger = (): { hosts: Map<string, string>; worktrees: Map<string, Worktree> } => {
        const empty = { hosts: new Map<string, string>(), worktrees: new Map<string, Worktree>() };
        try {
            const parsed: unknown = JSON.parse(readFileSync(ledger, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;
            const held = parsed as Partial<Ledger> & Record<string, unknown>;
            // The first version of this file was a flat name-to-host map; it is
            // read as the sessions it was.
            const sessions = held.sessions ?? (held as Record<string, unknown>);
            const hosts = new Map(
                Object.entries(sessions).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
            );
            const worktrees = new Map(
                Object.entries(held.projects ?? {}).filter(
                    (pair): pair is [string, Worktree] =>
                        typeof pair[1] === 'object' &&
                        pair[1] !== null &&
                        typeof (pair[1] as Worktree).host === 'string' &&
                        typeof (pair[1] as Worktree).path === 'string',
                ),
            );
            return { hosts, worktrees };
        } catch {
            return empty;
        }
    };

    const { hosts, worktrees } = readLedger();

    const rememberHosts = (): void => {
        try {
            mkdirSync(dirname(ledger), { recursive: true });
            const held: Ledger = {
                sessions: Object.fromEntries(hosts),
                projects: Object.fromEntries(worktrees),
            };
            writeFileSync(ledger, `${JSON.stringify(held, null, 2)}\n`);
        } catch {
            // A ledger that cannot be written costs the next process a host
            // name on the command line; it is not worth failing a session for.
        }
    };

    /**
     * What this laptop is logged in with: the api keys in the environment, and
     * auth.json for an oauth login, which no environment variable can carry.
     */
    const lend = (): Uint8Array => {
        const carried: Record<string, string> = {};
        for (const key of [
            'ANTHROPIC_API_KEY',
            'OPENAI_API_KEY',
            'GEMINI_API_KEY',
            'GOOGLE_API_KEY',
            'OPENROUTER_API_KEY',
        ]) {
            const value = process.env[key];
            if (value !== undefined && value !== '') carried[key] = value;
        }
        let auth: string | null = null;
        try {
            auth = readFileSync(join(process.env.HOME ?? '', '.pi', 'agent', 'auth.json'), 'utf8');
        } catch {
            // nothing stored here; the variables above may still carry a key
        }
        return new TextEncoder().encode(JSON.stringify({ env: carried, auth }));
    };

    const project = async (
        host: string,
        repo: string,
        projectName: string,
        branch: string,
        say: (note: string) => void,
    ): Promise<string> => {
        // The layout is one definition, shared with the checkout the agent
        // asks for on whatever machine it is attached to. See lib/remote/project.ts.
        const { script, worktree } = projectPlan(repo, branch, projectName);

        // Asked before the clone rather than discovered as GitHub's refusal:
        // -A with no agent forwards nothing, and the far side reports a
        // permission denied that sends people to look at their keys and the
        // host's authorized_keys, neither of which is the fault.
        const trouble = agentTrouble();
        if (trouble !== null) throw new Error(describeAgentTrouble(trouble, `${repoName(repo)} on ${host}`));

        say(`cloning ${repoName(repo)} on ${host}`);

        // -A forwards the agent for the clone. Without it a private repo needs
        // a key on the host, which is the thing this avoids.
        //
        // Not SSH_FLAGS: those clear every forwarding, which includes the
        // agent. The two options that matter here are kept by hand, and the
        // host key is accepted the same way as everywhere else rather than
        // asking a question nobody is there to answer.
        const done = await run('ssh', [
            '-o',
            'StrictHostKeyChecking=accept-new',
            '-o',
            'LogLevel=ERROR',
            '-A',
            host,
            script,
        ]);
        if (done.code !== 0) throw new Error(done.err.trim() || done.out.trim() || 'the clone failed');
        const path = done.out.trim().split('\n').pop() ?? worktree;
        return path;
    };

    const create = async (name: string, address: string, say: (note: string) => void): Promise<string> => {
        const address_ = parseAddress(address);
        if (address_ === null) throw new Error(`not a machine address: ${address}`);
        const host = sshTarget(address_);

        // One call, not four.
        //
        // Probing for a runtime, testing for the runner and starting it were
        // three round trips before the one that mattered, and a handshake to
        // this fleet is seconds rather than milliseconds. This asks the far
        // side to start the session if it already has what it needs, and to
        // say so plainly if it does not; only then is anything copied.
        const { hash } = await bundle();
        const file = `${REMOTE_DIR}/session-${hash}.js`;
        // The same agent on both machines: this pi, a bun new enough to run it,
        // and rho itself. Each is kept on the host and sent only when it is not
        // already the one that is wanted.
        const lentPi = await ensurePi(host, say).catch(() => null);
        const lentRho = await ensureRho(host, lentPi, say).catch(() => null);
        const withPi =
            (lentPi === null ? '' : `RHO_PI_CLI=${lentPi} `) + (lentRho === null ? '' : `RHO_RHO_DIR=${lentRho} `);
        const quick = [
            `R=$(command -v bun || command -v node || true)`,
            `[ -n "$R" ] || exit 42`,
            `[ -s ${file} ] || exit 43`,
            `${withPi}exec "$R" ${file} serve ${name} ${address_.path ?? '$HOME'}`,
        ].join('; ');
        /**
         * The name the client attaches by.
         *
         * The runner is installed by content hash so two versions never
         * collide, and the client needs one name that does not change. The
         * link is made beside whichever file was installed, in the same call
         * that starts the session, so it can never point at a file that is not
         * there.
         */
        const linkRunner = `ln -sf $(basename ${file}) ${RUNNER_LINK}`;

        const attempt = await run('ssh', [...SSH_FLAGS, host, quick], lend());
        // A session that is already up is the outcome asked for, not an error:
        // create is how you get one, and one exists.
        if (/already running/.test(attempt.out) || /already running/.test(attempt.err)) {
            hosts.set(name, host);
            rememberHosts();
            return `${name} is already running on ${host}`;
        }
        if (attempt.code === 0) {
            hosts.set(name, host);
            rememberHosts();
            await run('ssh', [...SSH_FLAGS, host, linkRunner]);
            return attempt.out.trim();
        }
        if (attempt.code !== 42 && attempt.code !== 43) {
            throw new Error(attempt.err.trim() || attempt.out.trim() || `could not start ${name}`);
        }

        const runner = await place(host, say);
        say(`starting ${name} on ${host}`);
        // The agent on the host needs a model key, and the host should not own
        // one: a key in a file there outlives the session and ends up in
        // backups. These go down the ssh channel into the session's
        // environment and die with it.
        const carried: Record<string, string> = {};
        for (const key of [
            'ANTHROPIC_API_KEY',
            'OPENAI_API_KEY',
            'GEMINI_API_KEY',
            'GOOGLE_API_KEY',
            'OPENROUTER_API_KEY',
        ]) {
            const value = process.env[key];
            if (value !== undefined && value !== '') carried[key] = value;
        }

        // Whatever this laptop is logged in with, including OAuth, which no
        // environment variable can carry: pi keeps it in auth.json, and the
        // session on the far side gets a config directory of its own holding
        // a copy for as long as it runs.
        let auth: string | null = null;
        try {
            auth = readFileSync(join(process.env.HOME ?? '', '.pi', 'agent', 'auth.json'), 'utf8');
        } catch {
            // nothing stored here; the environment variables above may still carry a key
        }

        const started = await run(
            'ssh',
            [...SSH_FLAGS, host, `${withPi}${runner} serve ${name} ${address_.path ?? '$HOME'}`],
            lend(),
        );
        await run('ssh', [...SSH_FLAGS, host, linkRunner]);
        if (started.code !== 0) {
            throw new Error(started.err.trim() || started.out.trim() || `could not start ${name}`);
        }
        hosts.set(name, host);
        rememberHosts();
        return started.out.trim();
    };

    /**
     * Run a runner command in one ssh call.
     *
     * Asking place() first meant probing for a runtime and checking for the
     * file before every list or stop: three round trips to this fleet is
     * seconds, and the answers cannot have changed since the runner was
     * installed. This uses the stable link, and installs only when the far
     * side says it is not there.
     */
    const ask = async (host: string, verb: string, say: (note: string) => void): Promise<string> => {
        const quick = [
            `R=$(command -v bun || command -v node || true)`,
            `[ -n "$R" ] || exit 42`,
            `[ -s ${RUNNER_LINK} ] || exit 43`,
            `exec "$R" ${RUNNER_LINK} ${verb}`,
        ].join('; ');
        const attempt = await run('ssh', [...SSH_FLAGS, host, quick]);
        if (attempt.code === 0) return attempt.out.trim();
        if (attempt.code !== 42 && attempt.code !== 43) {
            throw new Error(attempt.err.trim() || attempt.out.trim() || `${verb} failed on ${host}`);
        }
        const runner = await place(host, say);
        const again = await run('ssh', [...SSH_FLAGS, host, `${runner} ${verb}`]);
        return again.out.trim();
    };


    /**
     * The sessions this machine knows about, each with the host it is on.
     *
     * The ledger is what was started from here; the hosts in it are asked
     * whether those sessions are still running, so a list never offers one that
     * has been stopped from somewhere else.
     */
    const knownSessions = async (): Promise<{ name: string; host: string; state: 'running' | 'stopped' }[]> => {
        const machines = [...new Set([...hosts.values(), ...[...worktrees.values()].map((tree) => tree.host)])];
        const answers = await Promise.all(
            machines.map(async (host) => ({ host, sessions: await held(host).catch(() => []) })),
        );
        const found = answers.flatMap(({ host, sessions }) =>
            sessions.map((session) => ({ name: session.name, host, state: session.state })),
        );
        // Anything remembered here that the host did not mention: it was
        // forgotten over there, and offering it would be offering a ghost.
        return found.sort((a, b) => a.name.localeCompare(b.name));
    };

    /**
     * Which session, when the command did not say.
     *
     * A name is easier to pick from a list than to remember, and the list is
     * the only place that knows which of them are still running.
     */
    const chooseSession = async (ctx: ExtensionContext, verb: string): Promise<string | null> => {
        const sessions = await knownSessions();
        return browse(ctx, {
            title: `remote sessions to ${verb}`,
            empty: 'no remote sessions. /remote create <name> <user@host> starts one',
            items: () =>
                sessions.map((session) => ({
                    value: session.name,
                    label: session.name,
                    description: [
                        session.host,
                        session.state,
                        worktrees.has(session.name) ? 'project' : '',
                    ]
                        .filter((part) => part !== '')
                        .join(', '),
                })),
            action: () => ({ choose: verb }),
        });
    };

    /** One running session on one host, as the runner reports it. */
    interface Running {
        readonly name: string;
        readonly cwd: string;
    }

    const parseListing = (listed: string): Running[] =>
        listed
            .split('\n')
            .map((line) => line.split('\t'))
            .filter((columns) => columns.length >= 2 && columns[1]?.trim() === 'running')
            .map((columns) => ({ name: columns[0]?.trim() ?? '', cwd: columns[2]?.trim() ?? '' }))
            .filter((session) => session.name !== '');

    const running = async (host: string): Promise<Running[]> => parseListing(await ask(host, 'list', () => {}));

    /**
     * Every session this machine knows of, and what it is working on.
     *
     * A bare list of names could not tell a project's worktree from a home
     * directory, and a project started from here was not in it at all, because
     * only the sessions were written down.
     */
    const inventory = async (only?: string): Promise<string> => {
        const machines =
            only !== undefined
                ? [only]
                : [...new Set([...hosts.values(), ...[...worktrees.values()].map((tree) => tree.host)])];
        if (machines.length === 0) return 'no remote sessions. /remote create <name> <user@host> starts one';

        // Each machine is asked once, and they are asked at the same time.
        const answers = await Promise.all(
            machines.map(async (host) => ({ host, live: await running(host).catch(() => [] as Running[]) })),
        );

        const lines: string[] = [];
        for (const { host, live } of answers) {
            lines.push(`${host}:`);
            if (live.length === 0) {
                lines.push('  nothing running');
                continue;
            }
            for (const session of live) {
                const project = worktrees.get(session.name);
                const where = project !== undefined ? `project, ${project.path}` : session.cwd;
                lines.push(`  ${session.name}${where === '' ? '' : `  ${where}`}`);
            }
        }

        // Written down here but not running there: stopped from somewhere else,
        // or the machine could not be reached. A silent absence reads as a
        // session that was never created.
        const alive = new Set(answers.flatMap(({ live }) => live.map((session) => session.name)));
        const missing = [...new Set([...hosts.keys(), ...worktrees.keys()])].filter((name) => !alive.has(name));
        for (const name of missing) {
            const tree = worktrees.get(name);
            lines.push(`  ${name}  not running${tree === undefined ? '' : `, project at ${tree.path}`}`);
        }
        return lines.join('\n');
    };

    /**
     * The runner on that host, brought up to date.
     *
     * It is installed by content hash, so a newer rho is a different file and
     * the stable name is repointed at it. Done on connect as well as create:
     * the runner is rho's own code and a session started last week should not
     * be attached to by last week's version of it.
     */
    const ensureRunner = async (host: string, say: (note: string) => void): Promise<void> => {
        // One call for the usual case, where the runner is already the current
        // one: it checks and relinks in the same round trip, and only a runner
        // that is genuinely missing costs a second one. Asking separately took
        // three seconds of ssh handshakes to discover that nothing had changed.
        const { path, hash } = await bundle();
        const file = `${REMOTE_DIR}/session-${hash}.js`;
        const quick = [`[ -s ${file} ] || exit 43`, `ln -sf session-${hash}.js ${RUNNER_LINK}`].join('; ');
        const attempt = await run('ssh', [...SSH_FLAGS, host, quick]);
        if (attempt.code === 0) return;
        if (attempt.code !== 43) throw new Error(attempt.err.trim() || `could not reach ${host}`);

        say(`copying the session runner to ${host}`);
        const sent = await run(
            'ssh',
            [
                ...SSH_FLAGS,
                host,
                `mkdir -p ${REMOTE_DIR} && cat > ${file}.part && mv ${file}.part ${file} && ln -sf session-${hash}.js ${RUNNER_LINK}`,
            ],
            readFileSync(path),
        );
        if (sent.code !== 0) throw new Error(`could not copy the session runner: ${sent.err.trim()}`);
    };

    /**
     * The laptop's pi on that host, sent once per version.
     *
     * Returns the path to run, or null when there is nothing to send and the
     * host's own pi has to do. A host with no pi at all can hold a session
     * this way, and two machines that disagree about the version stop
     * disagreeing.
     */
    /**
     * A bun on that host new enough for this pi and for typescript extensions.
     *
     * Returns what to run it with. The host's own is used when it is new
     * enough; otherwise the official build for its architecture is fetched
     * once, kept here, and sent.
     */
    const ensureBun = async (host: string, say: (note: string) => void): Promise<string> => {
        const asked = await run('ssh', [...SSH_FLAGS, host, 'bun --version 2>/dev/null; echo ---; uname -m']);
        const [version = '', machine = ''] = asked.out.split('---');
        if (version.trim() !== '' && newEnough(version)) return 'bun';

        const mine = (await run('bun', ['--version'])).out.trim();
        const arm = machine.trim().startsWith('aarch64') || machine.trim().startsWith('arm64');
        const build = arm ? 'bun-linux-aarch64' : 'bun-linux-x64';
        const remote = `${BUN_DIR}/${mine}/bun`;
        const present = await run('ssh', [...SSH_FLAGS, host, `test -x ${remote} && echo yes || echo no`]);
        if (present.out.trim() === 'yes') return `$HOME/${remote}`;

        const zip = join(CACHE, `${build}-${mine}.zip`);
        if (!existsSync(zip)) {
            say(`fetching bun ${mine} for ${build.replace('bun-linux-', '')}`);
            const url = `https://github.com/oven-sh/bun/releases/download/bun-v${mine}/${build}.zip`;
            const got = await run('curl', ['-sSfL', '-o', zip, url]);
            if (got.code !== 0) throw new Error(`could not fetch bun ${mine}: ${got.err.trim()}`);
        }

        say(`sending bun ${mine} to ${host}`);
        const sent = await run(
            'ssh',
            [
                ...SSH_FLAGS,
                host,
                `mkdir -p $HOME/${BUN_DIR}/${mine} && cat > /tmp/bun-${mine}.zip && ` +
                    `cd $HOME/${BUN_DIR}/${mine} && unzip -oq /tmp/bun-${mine}.zip && ` +
                    `mv ${build}/bun bun && chmod +x bun && rm -rf ${build} /tmp/bun-${mine}.zip`,
            ],
            readFileSync(zip),
        );
        if (sent.code !== 0) throw new Error(`could not send bun to ${host}: ${sent.err.trim()}`);
        return `$HOME/${remote}`;
    };

    const ensurePi = async (host: string, say: (note: string) => void): Promise<string | null> => {
        const version = localPiVersion();
        if (version === null) return null;
        const root = `${PI_DIR}/${version}`;
        const cli = `$HOME/${root}/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`;

        // Installed rather than copied: pi's bundle is not self-contained, and
        // the copy that is enough for bun to auto-install its way through is
        // not enough for node. The package manager already knows how to put
        // exactly this version somewhere.
        const check = `[ -s ${cli} ] && echo yes || echo no`;
        const present = await run('ssh', [...SSH_FLAGS, host, check]);
        if (present.out.trim() === 'yes') return cli;

        say(`installing pi ${version} on ${host}`);
        const install = [
            `mkdir -p $HOME/${root}`,
            `cd $HOME/${root}`,
            `I=$(command -v bun || command -v npm || true)`,
            `[ -n "$I" ] || exit 44`,
            `case "$I" in *bun) "$I" add @earendil-works/pi-coding-agent@${version} ;;`,
            `                *) "$I" install --no-fund --no-audit @earendil-works/pi-coding-agent@${version} ;; esac`,
        ].join('; ');
        const made = await run('ssh', [...SSH_FLAGS, host, install]);
        if (made.code !== 0) throw new Error(`could not install pi ${version} on ${host}: ${made.err.trim()}`);
        return cli;
    };

    /**
     * rho itself on that host, so the agent there is the agent here.
     *
     * Without it the far side is pi with no extensions: none of rho's tools,
     * none of its prompt, and a different agent from the one this machine
     * talks to. The source is a few hundred kilobytes; its dependencies are
     * installed there, which takes about ten seconds the first time.
     *
     * Keyed by the content of what is sent, so an edit here is a different
     * directory there and nothing has to be invalidated by hand.
     */
    const ensureRho = async (host: string, piRoot: string | null, say: (note: string) => void): Promise<string | null> => {
        if (piRoot === null) return null;
        const root = join(remoteDir(), '..', '..', '..');

        // Built here, where bun is. The far side loads it with node, because a
        // host's bun can be older than this pi and the official build will not
        // run on NixOS at all, and node cannot load typescript.
        const packed = join(CACHE, 'remote-rho');
        const made = await run('bun', [join(root, 'bin', 'build-remote-rho'), packed]);
        if (made.code !== 0) throw new Error(`could not build rho for ${host}: ${made.err.trim() || made.out.trim()}`);

        const listing = await run('sh', ['-c', `cd ${JSON.stringify(packed)} && find . -type f | sort`]);
        const digest = createHash('sha256');
        for (const file of listing.out.split('\n').filter((name) => name !== '')) {
            try {
                digest.update(file).update(readFileSync(join(packed, file)));
            } catch {
                // a file that vanished between listing and reading is not sent
            }
        }
        const tag = digest.digest('hex').slice(0, 12);
        const remote = `${RHO_DIR}/${tag}`;
        const present = await run('ssh', [...SSH_FLAGS, host, `test -d ${remote}/extensions && echo yes || echo no`]);
        // The link is remade either way: it points at the pi this session runs,
        // and that pi's directory is where the bundles' externals resolve from.
        const link = `ln -sfn ${piRoot.replace(/\/dist\/bundle\/cli\.js$/, '')}/../.. ${remote}/node_modules`;
        if (present.out.trim() === 'yes') {
            await run('ssh', [...SSH_FLAGS, host, link]);
            return `$HOME/${remote}`;
        }

        say(`sending rho to ${host}`);
        const sent = await run('sh', [
            '-c',
            `tar czf - -C ${JSON.stringify(packed)} . | ssh ${SSH_FLAGS.join(' ')} ${host} ` +
                `'rm -rf ${remote}.part && mkdir -p ${remote}.part && tar xzf - -C ${remote}.part && ` +
                `rm -rf ${remote} && mv ${remote}.part ${remote} && ${link}'`,
        ]);
        if (sent.code !== 0) throw new Error(`could not send rho to ${host}: ${sent.err.trim()}`);
        return `$HOME/${remote}`;
    };

    /** Every session a host holds, stopped ones included. */
    const held = async (host: string): Promise<{ name: string; state: 'running' | 'stopped'; cwd: string }[]> => {
        const listed = await ask(host, 'all', () => {}).catch(() => '');
        return listed
            .split('\n')
            .map((line) => line.split('\t'))
            .filter((columns) => columns.length >= 2)
            .map((columns) => ({
                name: columns[0]?.trim() ?? '',
                state: (columns[1]?.trim() === 'running' ? 'running' : 'stopped') as 'running' | 'stopped',
                cwd: columns[2]?.trim() ?? '',
            }))
            .filter((session) => session.name !== '' && session.name !== 'no sessions');
    };

    const list = async (host: string): Promise<string> => {
        const listed = await ask(host, 'list', () => {});
        return listed || 'no sessions';
    };

    pi.registerCommand('remote', {
        description:
            'run the session on another machine: /remote create <name> user@host, /remote connect <name>, /remote list <user@host>',
        /**
         * What can be typed next, which depends on what has been typed.
         *
         * Completing verbs everywhere meant `/remote connect <tab>` offered
         * `create`, and never offered the session you were about to name.
         */
        getArgumentCompletions: (text) => {
            const { before, word } = lastWord(text);
            const first = before.trim().split(/\s+/)[0] ?? '';
            const verb = before.trim() === '' ? null : shorthandFor(first, VERBS);

            const sessionRows = [...new Set([...hosts.keys(), ...worktrees.keys()])].map((name) => ({
                value: name,
                description: worktrees.get(name)?.path ?? hosts.get(name) ?? '',
            }));
            const hostRows = [...new Set(hosts.values())].map((host) => ({ value: host }));

            const offers =
                verb === null
                    ? [...VERBS.map((name) => ({ value: name })), ...sessionRows]
                    : verb === 'connect' || verb === 'stop'
                      ? [...sessionRows, ...hostRows]
                      : verb === 'list' || verb === 'manage' || verb === 'create' || verb === 'project'
                        ? hostRows
                        : [];

            // Whole lines, not bare words: pi replaces the argument text with
            // the value it is given, so a value holding only this word throws
            // away everything typed before it.
            return completeLastWord(`${before}${word}`, offers);
        },
        handler: async (args, ctx) => {
            // `/remote l` is list, `/remote conn` is connect: the first word is
            // read as the shortest thing that still means one of these.
            const spoken = takeVerb(args, VERBS);
            const [first, second] = spoken.rest;
            let verb = spoken.verb;
            if (verb === null && spoken.typed !== '') {
                ctx.ui.notify(spoken.complaint ?? `no such subcommand: ${spoken.typed}`, 'error');
                return;
            }
            // `/remote` on its own is a question about which session, and that
            // is what the list is for: a usage line answers nobody.
            if (verb === null) verb = 'connect';

            if (verb === 'create') {
                if (first === undefined || second === undefined) {
                    ctx.ui.notify('Usage: /remote create <name> user@host[:/path]', 'error');
                    return;
                }
                // Said before the work, because pi takes the input field away
                // while a handler runs: ten seconds of ssh with nothing on
                // screen is indistinguishable from a session that has hung.
                const bar = progress(ctx);
                bar.say(`starting ${first} on ${second}`);
                try {
                    const note = await create(first, second, (text) => bar.say(text));
                    ctx.ui.notify(`${note}. /remote connect ${first} attaches to it.`, 'info');
                } catch (error) {
                    ctx.ui.notify(`Could not create ${first}: ${(error as Error).message}`, 'error');
                } finally {
                    bar.done();
                }
                return;
            }

            if (verb === 'project') {
                // /remote project <repo> [branch] [user@host] [as <name>]
                const asked = parseProjectRequest(spoken.rest);
                if (asked === null) {
                    ctx.ui.notify('Usage: /remote project <repo> [branch] [user@host] [as <name>]', 'error');
                    return;
                }
                const host = asked.host ?? [...hosts.values()][0];
                if (host === undefined) {
                    ctx.ui.notify('No host known yet: /remote project <repo> [branch] user@host', 'error');
                    return;
                }
                const projectName = repoName(asked.repo);
                const name = sessionName(asked.repo, asked.branch, asked.name ?? undefined);
                const bar = progress(ctx);
                bar.say(`setting up ${name} on ${host}`);
                try {
                    const worktree = await project(host, asked.repo, projectName, asked.branch, (note) => bar.say(note));
                    worktrees.set(name, { host, path: worktree });
                    hosts.set(name, host);
                    rememberHosts();
                    ctx.ui.notify(
                        `${name} is at ${worktree} on ${host}. /remote connect ${name} starts a session there.`,
                        'info',
                    );
                } catch (error) {
                    ctx.ui.notify(`Could not set up ${name}: ${(error as Error).message}`, 'error');
                } finally {
                    bar.done();
                }
                return;
            }

            if (verb === 'list') {
                ctx.ui.notify(await inventory(first), 'info');
                return;
            }

            if (verb === 'manage') {
                const host = first ?? [...hosts.values()][0];
                if (host === undefined) {
                    ctx.ui.notify('Usage: /remote manage user@host', 'error');
                    return;
                }
                // Stopping is not forgetting, so the two are different keys and
                // only one of them destroys anything.
                let sessions = await held(host);
                const refresh = async () => {
                    sessions = await held(host);
                };
                await browse(ctx, {
                    title: `sessions on ${host}`,
                    empty: `nothing on ${host}. /remote create <name> ${host} starts one`,
                    items: () =>
                        sessions.map((session) => ({
                            value: session.name,
                            label: session.name,
                            description: `${session.state}${session.cwd === '' ? '' : `, ${session.cwd}`}${
                                worktrees.has(session.name) ? ', project' : ''
                            }`,
                        })),
                    action: () => ({
                        choose: 'connect',
                        remove: 'stop',
                        extra: [
                            { key: 'r', label: 'rename', id: 'rename' },
                            { key: 'x', label: 'forget (deletes the transcript)', id: 'forget' },
                        ],
                    }),
                    remove: async (name) => {
                        await ask(host, `stop ${name}`, () => {});
                        await refresh();
                        return true;
                    },
                    extra: async (id, name) => {
                        if (id === 'rename') {
                            const to = await ctx.ui.input(`rename ${name} to`, name);
                            if (to === undefined || to.trim() === '' || to.trim() === name) return true;
                            const answer = await ask(host, `rename ${name} ${to.trim()}`, () => {}).catch(
                                (trouble: Error) => trouble.message,
                            );
                            ctx.ui.notify(answer, 'info');
                            const where = hosts.get(name);
                            if (where !== undefined) {
                                hosts.delete(name);
                                hosts.set(to.trim(), where);
                            }
                            const tree = worktrees.get(name);
                            if (tree !== undefined) {
                                worktrees.delete(name);
                                worktrees.set(to.trim(), tree);
                            }
                            rememberHosts();
                            await refresh();
                            return true;
                        }
                        // The one that destroys something asks first.
                        const sure = await ctx.ui.confirm(
                            `forget ${name}?`,
                            'this deletes its conversation on that machine. stopping it instead keeps everything.',
                        );
                        if (!sure) return true;
                        const answer = await ask(host, `forget ${name}`, () => {}).catch(
                            (trouble: Error) => trouble.message,
                        );
                        ctx.ui.notify(answer, 'info');
                        hosts.delete(name);
                        worktrees.delete(name);
                        rememberHosts();
                        await refresh();
                        return true;
                    },
                });
                return;
            }

            if (verb === 'connect') {
                const session = first ?? (await chooseSession(ctx, 'connect'));
                if (session === null) return;
                const address_ = second ?? hosts.get(session) ?? worktrees.get(session)?.host;
                if (address_ === undefined) {
                    ctx.ui.notify(`I do not know which host ${session} is on. /remote connect ${session} user@host`, 'error');
                    return;
                }
                // An address given here is create's argument, so connect takes
                // create's place when there is nothing to connect to: asking
                // for a session is asking for it to exist.
                const host = address_.includes(':') ? address_.slice(0, address_.indexOf(':')) : address_;
                // Running, not merely known: a stopped session is one that has to
                // be started again, and attaching to it found no socket and
                // bounced straight back to this interface.
                const alreadyThere = (await held(host).catch(() => [])).some(
                    (found) => found.name === session && found.state === 'running',
                );
                if (!alreadyThere) {
                    // A project's session belongs in its worktree, which is the
                    // whole point of having made one.
                    const tree = worktrees.get(session);
                    const where = tree === undefined ? address_ : `${tree.host}:${tree.path}`;
                    const bar = progress(ctx);
                    bar.say(`starting ${session} on ${host}`);
                    try {
                        await create(session, where, (text) => bar.say(text));
                    } catch (error) {
                        ctx.ui.notify(`Could not create ${session}: ${(error as Error).message}`, 'error');
                        return;
                    } finally {
                        bar.done();
                    }
                }
                // The terminal is handed over, not described.
                //
                // The interface that draws a remote session is a different
                // process, and this one owns the terminal. Shutting down and
                // spawning it does not work: the child dies with the parent
                // and the window closes. pi already knows how to stand aside
                // for a program that needs the terminal -- it is what it does
                // for an external editor -- so this borrows that: the drawing
                // stops, the client runs in its place, and when it exits the
                // interface comes back exactly as it was.
                // rho's own code on that machine, brought up to date before it
                // is used: a session started last week should not be attached
                // to by last week's runner.
                await ensureRunner(host, () => {}).catch(() => {
                    // An update that cannot be made is not a reason to refuse a
                    // session that is already running.
                });

                const client = join(rhoRoot(), 'bin', 'rho-remote');
                // Why the client left, since the screen it wrote on is redrawn
                // by this interface the moment it returns.
                let left = 0;
                let said = '';
                await ctx.ui.custom<void>(
                    (tui, _theme, _keys, done) => {
                        queueMicrotask(() => {
                            tui.stop();
                            try {
                                // stderr is captured rather than inherited: it is
                                // where the client says why it stopped, and this
                                // interface redraws over it the moment it returns.
                                const ran = spawnSync('bun', [client, host, session], {
                                    stdio: ['inherit', 'inherit', 'pipe'],
                                    encoding: 'utf8',
                                });
                                left = ran.status ?? 1;
                                said = ran.stderr ?? '';
                            } finally {
                                tui.start();
                                tui.requestRender(true);
                                done();
                            }
                        });
                        return {
                            render: () => [],
                            handleInput: () => {},
                        } as never;
                    },
                    { overlay: true },
                );
                if (left === 0) {
                    ctx.ui.notify(`back from ${session} on ${host}, which is still running`, 'info');
                    return;
                }
                const trouble = troubleWith(said, session, host);
                ctx.ui.notify(
                    trouble.advice === null ? trouble.reason : `${trouble.reason}\n${trouble.advice}`,
                    'error',
                );
                return;
            }

            if (verb === 'stop') {
                const session = first ?? (await chooseSession(ctx, 'stop'));
                if (session === null) return;
                const host = hosts.get(session) ?? second;
                if (host === undefined) {
                    ctx.ui.notify(`I do not know which host ${session} is on.`, 'error');
                    return;
                }
                await ask(host, `stop ${session}`, () => {});
                hosts.delete(session);
                rememberHosts();
                ctx.ui.notify(`Stopped ${session}.`, 'info');
                return;
            }

            ctx.ui.notify(
                'Usage: /remote create <name> user@host | /remote connect <name> | /remote list user@host | /remote stop <name>',
                'error',
            );
        },
    });

    // Same reason as the environment tool: described by the skill, loaded when
    // something asks for it rather than carried by every session.
    const OWN = ['remote_session'];
    const load = (): void => {
        const active = pi.getActiveTools();
        const missing = OWN.filter((name) => !active.includes(name));
        if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
    };

    pi.on('input', async (event) => {
        if (/\bremote\b|skill:remote|\bsession on\b/i.test(event.text)) load();
        return { action: 'continue' as const };
    });

    // Same as environment.ts: a timer fires during extension loading, where
    // action methods throw and take the session with them.
    let hidden = false;
    pi.on('before_agent_start', async () => {
        if (hidden) return;
        hidden = true;
        pi.setActiveTools(pi.getActiveTools().filter((name) => !OWN.includes(name)));
    });

    pi.registerTool({
        name: 'remote_session',
        label: 'Remote session',
        description:
            'Start or inspect an agent session on another machine, which keeps running when this one stops. create starts a named session; list says what is running there.',
        promptSnippet: 'Run an agent session on a machine that stays up',
        promptGuidelines: [
            'Use remote_session create when work should outlive this session, for example on a host that is never switched off.',
        ],
        parameters: Type.Object({
            action: Type.Union([Type.Literal('create'), Type.Literal('list')]),
            name: Type.Optional(Type.String()),
            host: Type.Optional(Type.String({ description: 'user@host, optionally with :/path' })),
        }),
        async execute(_id, params: { action: 'create' | 'list'; name?: string; host?: string }) {
            const said = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
            try {
                if (params.action === 'list') {
                    if (params.host === undefined) return said('list needs a host.');
                    return said(await list(params.host));
                }
                if (params.name === undefined || params.host === undefined) {
                    return said('create needs a name and a host.');
                }
                return said(await create(params.name, params.host, () => {}));
            } catch (error) {
                return said(`Failed: ${(error as Error).message}`);
            }
        },
    });
}
