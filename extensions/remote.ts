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
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseTarget } from './lib/remote/deploy';

const CACHE = join(process.env.HOME ?? '/tmp', '.cache', 'rho', 'remote');
const REMOTE_DIR = '.cache/rho/remote';
const ENTRY = join(import.meta.dir, 'lib', 'remote', 'session-main.ts');

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
    const hash = createHash('sha256')
        .update(readFileSync(ENTRY))
        .update(readFileSync(join(import.meta.dir, 'lib', 'remote', 'broker.ts')))
        .update(readFileSync(join(import.meta.dir, 'lib', 'remote', 'protocol.ts')))
        .digest('hex')
        .slice(0, 16);
    mkdirSync(CACHE, { recursive: true });
    const out = join(CACHE, `session-${hash}.js`);
    try {
        if (statSync(out).size > 0) return { path: out, hash };
    } catch {
        // not bundled yet
    }
    const built = await run('bun', ['build', ENTRY, '--target=node', '--outfile', out]);
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
        const started = await run('ssh', [
            target.host,
            `${runner} serve ${name} ${target.path ?? '$HOME'}`,
        ]);
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
            const words = ['create', 'connect', 'list', 'stop', ...hosts.keys()];
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
                const host = second ?? hosts.get(first);
                if (host === undefined) {
                    ctx.ui.notify(`I do not know which host ${first} is on. /remote connect ${first} user@host`, 'error');
                    return;
                }
                const runner = await place(host, () => {});
                // The viewer replaces this terminal's session: pi's own RPC
                // client, pointed at the socket on the host through ssh. What
                // comes back is the same event stream a local session emits,
                // so the TUI draws it without knowing where it came from.
                ctx.ui.notify(
                    [
                        `Attaching to ${first} on ${host}.`,
                        `If this terminal is not a viewer yet, run:`,
                        `  ssh -t ${host} ${runner} attach ${first}`,
                    ].join('\n'),
                    'info',
                );
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
