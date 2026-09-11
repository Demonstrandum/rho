/**
 * /remote — the session runs on the always-on host, the laptop only looks at it.
 *
 *   /remote create work samuel@robotics-vm        start a named session there
 *   /remote create work samuel@robotics-vm:/srv   ... in a directory
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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { addressName, parseAddress, sshTarget } from './lib/remote/address';

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
    `ControlPath=${join(CACHE, 'cm-%C')}`,
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

/**
 * Where a project lives on the host. One clone, many worktrees, because that
 * is what a session per branch needs: a worktree is a directory sharing one
 * object store, so ten branches cost one clone rather than ten.
 *
 *   ~/projects/<project>/checkout/<repo>     the clone
 *   ~/projects/<project>/worktrees/<branch>  where a session works
 */
const PROJECTS = 'projects';

const repoName = (repo: string): string =>
    (repo.split('/').pop() ?? repo).replace(/\.git$/, '').replace(/[^A-Za-z0-9._-]/g, '-');

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
    const hosts = new Map<string, string>();
    /** A project's worktree, so connecting to it starts the session in the right directory. */
    const worktrees = new Map<string, { host: string; path: string }>();

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
        const name = repoName(repo);
        const root = `$HOME/${PROJECTS}/${projectName}`;
        const checkout = `${root}/checkout/${name}`;
        const worktree = `${root}/worktrees/${branch}`;

        say(`cloning ${name} on ${host}`);
        const script = [
            `set -e`,
            // The host may never have spoken to this forge before, and a first
            // clone otherwise dies on "Host key verification failed" with no
            // way to answer the prompt: there is no terminal on this side of
            // the ssh call. accept-new trusts an unknown host once and still
            // refuses a host whose key has changed, which is the case that
            // matters.
            `export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"`,
            `mkdir -p ${root}/checkout ${root}/worktrees`,
            // Idempotent: running it twice fetches rather than failing, so a
            // second worktree on an existing project is one command.
            `if [ -d ${checkout}/.git ]; then git -C ${checkout} fetch --all --prune;`,
            `else git clone ${JSON.stringify(repo)} ${checkout}; fi`,
            // An existing worktree is reused rather than refused: asking for
            // the same branch twice should land you in it, not error.
            `if [ ! -d ${worktree} ]; then`,
            `  if git -C ${checkout} show-ref --verify --quiet refs/heads/${branch}; then`,
            `    git -C ${checkout} worktree add ${worktree} ${branch};`,
            `  elif git -C ${checkout} show-ref --verify --quiet refs/remotes/origin/${branch}; then`,
            `    git -C ${checkout} worktree add --track -b ${branch} ${worktree} origin/${branch};`,
            `  else`,
            `    git -C ${checkout} worktree add -b ${branch} ${worktree};`,
            `  fi;`,
            `fi`,
            `echo ${worktree}`,
        ].join('\n');

        // -A forwards the agent for the clone. Without it a private repo needs
        // a key on the host, which is the thing this avoids.
        const done = await run('ssh', ['-A', host, script]);
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
        const quick = [
            `R=$(command -v bun || command -v node || true)`,
            `[ -n "$R" ] || exit 42`,
            `[ -s ${file} ] || exit 43`,
            `exec "$R" ${file} serve ${name} ${address_.path ?? '$HOME'}`,
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
            return `${name} is already running on ${host}`;
        }
        if (attempt.code === 0) {
            hosts.set(name, host);
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
            [...SSH_FLAGS, host, `${runner} serve ${name} ${address_.path ?? '$HOME'}`],
            lend(),
        );
        await run('ssh', [...SSH_FLAGS, host, linkRunner]);
        if (started.code !== 0) {
            throw new Error(started.err.trim() || started.out.trim() || `could not start ${name}`);
        }
        hosts.set(name, host);
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

    const list = async (host: string): Promise<string> => {
        const listed = await ask(host, 'list', () => {});
        return listed || 'no sessions';
    };

    pi.registerCommand('remote', {
        description:
            'run the session on another machine: /remote create <name> user@host, /remote connect <name>, /remote list <user@host>',
        getArgumentCompletions: (prefix) => {
            const words = ['create', 'connect', 'project', 'list', 'stop', ...hosts.keys(), ...worktrees.keys()];
            const found = words.filter((word) => word.startsWith(prefix));
            return found.length > 0 ? found.map((word) => ({ value: word, label: word })) : null;
        },
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean);
            const [verb, first, second] = parts;

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
                // /remote project <repo> <project/branch> [user@host]
                if (first === undefined || second === undefined) {
                    ctx.ui.notify('Usage: /remote project <repo> <project/branch> [user@host]', 'error');
                    return;
                }
                const host = parts[3] ?? [...hosts.values()][0];
                if (host === undefined) {
                    ctx.ui.notify('No host known yet: /remote project <repo> <project/branch> user@host', 'error');
                    return;
                }
                const [projectName, ...branchParts] = second.split('/');
                const branch = branchParts.join('/') || 'main';
                if (projectName === undefined) {
                    ctx.ui.notify('Give a project name: <project>/<branch>', 'error');
                    return;
                }
                const bar = progress(ctx);
                bar.say(`setting up ${projectName} on ${host}`);
                try {
                    const worktree = await project(host, first, projectName, branch, (note) => bar.say(note));
                    worktrees.set(projectName, { host, path: worktree });
                    hosts.set(projectName, host);
                    ctx.ui.notify(
                        `${projectName} is at ${worktree} on ${host}. /remote connect ${projectName} starts a session there.`,
                        'info',
                    );
                } catch (error) {
                    ctx.ui.notify(`Could not set up ${projectName}: ${(error as Error).message}`, 'error');
                } finally {
                    bar.done();
                }
                return;
            }

            if (verb === 'list') {
                const host = first ?? [...hosts.values()][0];
                if (host === undefined) {
                    ctx.ui.notify('Usage: /remote list user@host', 'error');
                    return;
                }
                ctx.ui.notify(await list(host), 'info');
                return;
            }

            if (verb === 'connect') {
                if (first === undefined) {
                    ctx.ui.notify('Usage: /remote connect <name>', 'error');
                    return;
                }
                const host = second ?? hosts.get(first) ?? worktrees.get(first)?.host;
                if (host === undefined) {
                    ctx.ui.notify(`I do not know which host ${first} is on. /remote connect ${first} user@host`, 'error');
                    return;
                }
                // The terminal is handed over, not described.
                //
                // The interface that draws a remote session is a different
                // process: this one owns the terminal, so it stands down and
                // the client takes it, and when the client exits the terminal
                // is free again. The session is untouched either way -- it
                // lives on the far side and neither process owns it.
                const client = join(rhoRoot(), 'bin', 'rho-remote');
                ctx.ui.notify(`handing this terminal to ${first} on ${host}`, 'info');
                const viewer = spawn('bun', [client, host, first], {
                    stdio: 'inherit',
                    detached: false,
                });
                viewer.on('error', (error) =>
                    ctx.ui.notify(`could not start the client: ${error.message}`, 'error'),
                );
                ctx.shutdown();
                return;
            }

            if (verb === 'stop') {
                if (first === undefined) {
                    ctx.ui.notify('Usage: /remote stop <name>', 'error');
                    return;
                }
                const host = hosts.get(first) ?? second;
                if (host === undefined) {
                    ctx.ui.notify(`I do not know which host ${first} is on.`, 'error');
                    return;
                }
                await ask(host, `stop ${first}`, () => {});
                hosts.delete(first);
                ctx.ui.notify(`Stopped ${first}.`, 'info');
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
