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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseTarget } from './lib/remote/deploy';

const CACHE = join(process.env.HOME ?? '/tmp', '.cache', 'rho', 'remote');
const REMOTE_DIR = '.cache/rho/remote';
// Same reason as deploy.ts: import.meta.dir is a data URL when pi loads this
// from a bundle, and every read then fails with ENAMETOOLONG.
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

/** Put the runner on the host if it is not there, and say how to start it. */
async function place(host: string, say: (note: string) => void): Promise<string> {
    const probe = await run('ssh', [host, 'command -v bun || command -v node || true']);
    if (probe.code !== 0) throw new Error(`cannot reach ${host}: ${probe.err.trim() || 'ssh failed'}`);
    const runtime = probe.out.trim().split('\n')[0]?.trim();
    if (runtime === undefined || runtime === '') {
        throw new Error(`${host} has neither bun nor node, and the session runner needs one`);
    }

    const { path, hash } = await bundle();
    const remote = `${REMOTE_DIR}/session-${hash}.js`;
    const present = await run('ssh', [host, `test -s ${remote} && echo yes || echo no`]);
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

export default function (pi: ExtensionAPI) {
    /** Where each named session lives, so connect and stop need only the name. */
    const hosts = new Map<string, string>();
    /** A project's worktree, so connecting to it starts the session in the right directory. */
    const worktrees = new Map<string, { host: string; path: string }>();

    /**
     * The session this terminal is looking at, if it is looking at one.
     *
     * While it is set, typing here goes there and its events are drawn here.
     * The agent on this machine runs nothing: it is a viewer, which is the
     * point -- the work is on a host that stays up, and this laptop can close.
     */
    let viewing: { name: string; host: string; child: ReturnType<typeof spawn> } | null = null;
    /** A viewer that closed by itself, so input refuses rather than running here. */
    let lost: { name: string; host: string } | null = null;

    const show = (text: string): void => {
        pi.sendMessage({ customType: 'remote', content: text, display: true }, {});
    };

    /**
     * pi's own event stream, rendered.
     *
     * Only what a person watching needs: the assistant's words, which tools
     * ran, and when a turn finished. The full stream carries deltas for every
     * token, and redrawing those here would be streaming a UI rather than
     * building one from data.
     */
    const draw = (line: string): void => {
        let event: { type?: string; message?: { content?: unknown }; toolName?: string; error?: string };
        try {
            event = JSON.parse(line) as typeof event;
        } catch {
            return;
        }
        if (event.type === 'message_end') {
            const content = event.message?.content;
            const text = Array.isArray(content)
                ? content
                      .filter(
                          (part): part is { type: string; text: string } =>
                              typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
                      )
                      .map((part) => part.text)
                      .join('')
                      .trim()
                : '';
            if (text !== '') show(text);
            return;
        }
        if (event.type === 'tool_execution_start' && event.toolName !== undefined) {
            show(`· ${event.toolName}`);
            return;
        }
        if (event.type === 'extension_error' && event.error !== undefined) {
            show(`remote extension error: ${event.error}`);
        }
    };

    const view = async (name: string, host: string, runner: string): Promise<void> => {
        const child = spawn('ssh', [host, `${runner} attach ${name}`], { stdio: ['pipe', 'pipe', 'pipe'] });
        viewing = { name, host, child };
        let held = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            held += chunk.toString();
            const lines = held.split('\n');
            held = lines.pop() ?? '';
            for (const line of lines) if (line.trim() !== '') draw(line);
        });
        child.on('close', () => {
            if (viewing?.name === name) {
                viewing = null;
                // Not the same as leaving on purpose. Until somebody says what
                // to do, typing here must not quietly become a local turn: the
                // person believes they are talking to the session on the host,
                // and a local agent answering in its place is the same silent
                // wrong-machine failure the environment used to have.
                lost = { name, host };
                show(
                    `The viewer for ${name} closed. It is still running on ${host}.\n` +
                        `Typing here will not reach it: /remote connect ${name} to attach again, ` +
                        'or /remote disconnect to work locally.',
                );
            }
        });
    };

    // Typing goes to the session being viewed, not to a local agent.
    pi.on('input', async (event, ctx) => {
        if (event.source === 'extension') return { action: 'continue' as const };
        // Commands always work: they are how the person gets out of this.
        if (event.text.startsWith('/')) return { action: 'continue' as const };

        if (viewing === null) {
            if (lost === null) return { action: 'continue' as const };
            ctx.ui.notify(
                `Not connected to ${lost.name} any more, so that went nowhere. ` +
                    `/remote connect ${lost.name} attaches again; /remote disconnect works here instead.`,
                'error',
            );
            return { action: 'handled' as const };
        }

        const stdin = viewing.child.stdin;
        if (stdin === null || stdin === undefined || stdin.destroyed) {
            const { name, host } = viewing;
            viewing = null;
            lost = { name, host };
            ctx.ui.notify(`The connection to ${name} is closed, so that was not sent.`, 'error');
            return { action: 'handled' as const };
        }
        stdin.write(`${JSON.stringify({ type: 'prompt', message: event.text })}\n`);
        return { action: 'handled' as const };
    });

    /**
     * Clone on the host using the laptop's credentials.
     *
     * `ssh -A` forwards the agent, so the host authenticates to GitHub as the
     * person sitting here and no deploy key has to exist on it. The key never
     * lands on the host: only the ability to use it, for as long as the
     * connection is open.
     */
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
            // The host may never have spoken to this cloud before, and a first
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
        const target = parseTarget(address);
        const runner = await place(target.host, say);
        say(`starting ${name} on ${target.host}`);
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
        const started = await run(
            'ssh',
            [target.host, `${runner} serve ${name} ${target.path ?? '$HOME'}`],
            new TextEncoder().encode(JSON.stringify(carried)),
        );
        if (started.code !== 0) {
            throw new Error(started.err.trim() || started.out.trim() || `could not start ${name}`);
        }
        hosts.set(name, target.host);
        return started.out.trim();
    };

    const list = async (host: string): Promise<string> => {
        const runner = await place(host, () => {});
        const listed = await run('ssh', [host, `${runner} list`]);
        return listed.out.trim() || 'no sessions';
    };

    pi.registerCommand('remote', {
        description:
            'run the session on another machine: /remote create <name> user@host, /remote connect <name>, /remote list <user@host>',
        getArgumentCompletions: (prefix) => {
            const words = ['create', 'connect', 'project', 'list', 'stop', 'disconnect', ...hosts.keys(), ...worktrees.keys()];
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
                try {
                    const note = await create(first, second, (text) => ctx.ui.notify(text, 'info'));
                    ctx.ui.notify(`${note}. /remote connect ${first} attaches to it.`, 'info');
                } catch (error) {
                    ctx.ui.notify(`Could not create ${first}: ${(error as Error).message}`, 'error');
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
                try {
                    const worktree = await project(host, first, projectName, branch, (note) =>
                        ctx.ui.notify(note, 'info'),
                    );
                    worktrees.set(projectName, { host, path: worktree });
                    hosts.set(projectName, host);
                    ctx.ui.notify(
                        `${projectName} is at ${worktree} on ${host}. /remote connect ${projectName} starts a session there.`,
                        'info',
                    );
                } catch (error) {
                    ctx.ui.notify(`Could not set up ${projectName}: ${(error as Error).message}`, 'error');
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
                // A project that has no session yet gets one, in its worktree,
                // so /remote project then /remote connect is the whole of it.
                const known = worktrees.get(first);
                if (known !== undefined && !hosts.has(`${first}:session`)) {
                    try {
                        await create(first, `${known.host}:${known.path}`, (note) => ctx.ui.notify(note, 'info'));
                        hosts.set(`${first}:session`, known.host);
                    } catch (error) {
                        ctx.ui.notify(`Could not start a session for ${first}: ${(error as Error).message}`, 'error');
                        return;
                    }
                }
                const host = second ?? hosts.get(first);
                if (host === undefined) {
                    ctx.ui.notify(`I do not know which host ${first} is on. /remote connect ${first} user@host`, 'error');
                    return;
                }
                const runner = await place(host, () => {});
                await view(first, host, runner);
                ctx.ui.notify(
                    `Viewing ${first} on ${host}. What you type goes there; /remote disconnect comes back.`,
                    'info',
                );
                return;
            }

            if (verb === 'disconnect') {
                if (viewing === null) {
                    // Clearing this is what makes typing work again after a
                    // viewer died: it is the deliberate choice to work here.
                    const was = lost;
                    lost = null;
                    ctx.ui.notify(
                        was === null
                            ? 'Not viewing anything.'
                            : `Left ${was.name}; it is still running on ${was.host}. Working locally.`,
                        'info',
                    );
                    return;
                }
                const { name, host } = viewing;
                viewing.child.kill('SIGTERM');
                viewing = null;
                lost = null;
                // Leaving is not stopping: the session stays up, which is the
                // difference between this and an ssh that owns the agent.
                ctx.ui.notify(`Left ${name}. It is still running on ${host}.`, 'info');
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
                const runner = await place(host, () => {});
                await run('ssh', [host, `${runner} stop ${first}`]);
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
