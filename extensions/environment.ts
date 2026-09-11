/**
 * /environment — the agent works somewhere else.
 *
 *   /environment connect samuel@gpucluster        attach, and make it current
 *   /environment connect samuel@box:/srv/work     attach, starting in a directory
 *   /environment default gpucluster               switch which one is current
 *   /environment default local                    come back
 *   /environment                                  what is attached, and where
 *
 * After connecting, bash, read, write and edit act on that machine. Not by
 * prefixing ssh: prefixing loses the working directory between commands, pays
 * a connection each time, cannot stream, and cannot keep a large output where
 * it was produced. An executor on the far side keeps all four.
 *
 * The agent has the same three verbs as tools, so it can allocate a node,
 * connect, work, and drop back when the node dies. It will die: these are
 * pre-empted machines, and the design treats that as the normal ending rather
 * than an error.
 */

import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    createBashTool,
    createEditTool,
    createReadTool,
    createWriteTool,
} from '@earendil-works/pi-coding-agent';
import { operationsFor, waitFor } from './lib/remote/client';
import type { Connection } from './lib/remote/client';
import { deploy, parseTarget } from './lib/remote/deploy';

interface Environment {
    readonly name: string;
    readonly connection: Connection;
    readonly host: string;
}

/**
 * Where the tools are acting, published for anything that describes the
 * session to the model.
 *
 * On globalThis because the extensions are separate modules with no import
 * between them, and a model told it is in one place while its tools act in
 * another will reason about the wrong machine: the environment block reads
 * this, and /cwd changes directory here rather than on the laptop.
 */
export interface Where {
    readonly name: string;
    readonly host: string;
    cwd: string;
    readonly shell: string;
    readonly alive: boolean;
    chdir(path: string): Promise<string>;
}

const PUBLISHED = '__rho_environment';
const published = globalThis as typeof globalThis & { [PUBLISHED]?: Where | undefined };

export const currentEnvironment = (): Where | undefined => published[PUBLISHED];

export default function (pi: ExtensionAPI) {
    const environments = new Map<string, Environment>();
    let current: string | null = null;

    const active = (): Environment | null => (current === null ? null : (environments.get(current) ?? null));

    /**
     * A dead connection is refused, not replaced by the laptop.
     *
     * Falling back to local was worse than failing: the command ran, the
     * output looked plausible, and it came from the wrong machine. The name
     * stays until somebody chooses where to go next.
     */
    const forget = (name: string, why: string): void => {
        environments.delete(name);
        if (current === name) {
            dead = { name, why };
            published[PUBLISHED] = undefined;
        }
        pi.sendMessage(
            {
                customType: 'environment',
                content:
                    `The environment ${name} is gone: ${why}.\n` +
                    'Tools will refuse rather than run here by mistake. ' +
                    `Reconnect with environment connect, or environment default local to work on this machine.`,
                display: true,
            },
            { deliverAs: 'followUp' },
        );
    };

    /** The last environment that died, so a tool can say so rather than acting locally. */
    let dead: { name: string; why: string } | null = null;

    /** What the far side is: directory, shell, and whether it is a repository. */
    const describe = async (environment: Environment): Promise<string> => {
        const facts: string[] = [`host: ${environment.host}`];
        const where = await environment.connection.request({ kind: 'cwd' });
        const cwd = where.kind === 'cwd' ? where.path : 'unknown';
        facts.push(`cwd: ${cwd}`);
        const probe = await environment.connection.request({
            kind: 'spawn',
            command: 'echo "$SHELL"; uname -sr; git rev-parse --is-inside-work-tree 2>/dev/null || echo no',
        });
        if (probe.kind === 'spawned') {
            await waitFor(environment.connection, probe.process);
            const out = await environment.connection.request({
                kind: 'read-range',
                process: probe.process,
                stream: 'stdout',
                offset: 0,
                length: 512,
            });
            void environment.connection.request({ kind: 'release', process: probe.process });
            if (out.kind === 'bytes') {
                const [shell = '', platform = '', repo = ''] = new TextDecoder()
                    .decode(out.data)
                    .trim()
                    .split('\n');
                facts.push(`shell: ${shell || 'unknown'}`);
                facts.push(`platform: ${platform || 'unknown'}`);
                facts.push(`git repo: ${repo.trim() === 'true' ? 'yes' : 'no'}`);
                published[PUBLISHED] = {
                    name: environment.name,
                    host: environment.host,
                    cwd,
                    shell: shell || 'unknown',
                    alive: true,
                    chdir: async (path: string) => {
                        const moved = await environment.connection.request({ kind: 'chdir', path });
                        if (moved.kind !== 'cwd') {
                            throw new Error(moved.kind === 'error' ? moved.message : 'could not change directory');
                        }
                        const state = published[PUBLISHED];
                        if (state !== undefined) state.cwd = moved.path;
                        return moved.path;
                    },
                };
            }
        }
        return facts.join('\n');
    };

    /** Said out loud, because a change of machine the model cannot see is a trap. */
    const announce = async (environment: Environment | null): Promise<void> => {
        const content =
            environment === null
                ? `<environment>\nworking locally on this machine\n</environment>`
                : `<environment>\n${await describe(environment)}\n</environment>`;
        pi.sendMessage({ customType: 'environment', content, display: true }, { deliverAs: 'followUp' });
    };

    const attach = async (name: string, address: string, note: (text: string) => void): Promise<Environment> => {
        const target = parseTarget(address);
        const connection = await deploy(target, { onProgress: note });
        const environment: Environment = { name, connection, host: address };
        connection.onEvent((event) => {
            if (event.kind === 'gone') forget(name, event.why);
        });
        environments.set(name, environment);
        current = name;
        dead = null;
        await announce(environment);
        return environment;
    };

    // ── the tools, routed ───────────────────────────────────────────────────
    // Re-registering pi's own tools under their own names, with operations
    // that point at the current environment. The tool keeps its argument
    // handling and output formatting; only where it acts changes.
    const localRead = createReadTool(process.cwd());
    const localWrite = createWriteTool(process.cwd());
    const localEdit = createEditTool(process.cwd());
    const localBash = createBashTool(process.cwd());

    const route = <T extends { execute: (...args: never[]) => unknown }>(
        local: T,
        make: (operations: ReturnType<typeof operationsFor>) => T,
    ): T =>
        ({
            ...local,
            async execute(...args: never[]) {
                // An environment that died is not the same as no environment.
                // Running locally here is how a command silently answered from
                // the wrong machine, so it refuses until somebody chooses.
                if (dead !== null) {
                    throw new Error(
                        `the environment ${dead.name} is gone (${dead.why}), so this did not run. ` +
                            'Reconnect it, or switch to local deliberately with environment default local.',
                    );
                }
                const environment = active();
                if (environment === null) return (local.execute as (...a: never[]) => unknown)(...args);
                if (!environment.connection.alive) {
                    throw new Error(`the connection to ${environment.name} is closed, so this did not run`);
                }
                const remote = make(operationsFor(environment.connection));
                return (remote.execute as (...a: never[]) => unknown)(...args);
            },
        }) as T;

    pi.registerTool(route(localRead, (ops) => createReadTool(process.cwd(), { operations: ops.read })));
    pi.registerTool(route(localWrite, (ops) => createWriteTool(process.cwd(), { operations: ops.write })));
    pi.registerTool(route(localEdit, (ops) => createEditTool(process.cwd(), { operations: ops.edit })));
    pi.registerTool(route(localBash, (ops) => createBashTool(process.cwd(), { operations: ops.bash })));

    /**
     * Loaded rather than always present.
     *
     * A tool definition costs prompt on every request of every session,
     * including the ones that never touch another machine. The skill describes
     * these in a line the model can act on, and the definition arrives when
     * something asks for it: the skill being read, the command being used, or
     * a machine being attached.
     */
    const OWN = ['environment'];
    const load = (): void => {
        const active = pi.getActiveTools();
        const missing = OWN.filter((name) => !active.includes(name));
        if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
    };

    pi.on('input', async (event) => {
        if (/\benvironment\b|skill:remote|\bsymba\b|\bgpu\b/i.test(event.text)) load();
        return { action: 'continue' as const };
    });

    // ── the same three verbs, for the agent ────────────────────────────────
    pi.registerTool({
        name: 'environment',
        label: 'Environment',
        description:
            'Work on another machine. connect attaches one and makes it current; default switches between an attached one and "local"; list says what is attached. After connecting, bash, read, write and edit act there.',
        promptSnippet: 'Run tools on another machine',
        promptGuidelines: [
            'Use environment connect after allocating a node, and environment default local when it is finished with.',
            'A rented node can vanish mid-command: if an environment goes, say so rather than retrying against it.',
        ],
        parameters: Type.Object({
            action: Type.Union([Type.Literal('connect'), Type.Literal('default'), Type.Literal('list')]),
            target: Type.Optional(
                Type.String({ description: 'For connect: user@host or user@host:/path. For default: a name, or "local".' }),
            ),
            name: Type.Optional(Type.String({ description: 'What to call it. Defaults to the host.' })),
        }),
        async execute(_id, params: { action: 'connect' | 'default' | 'list'; target?: string; name?: string }) {
            const said = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });

            if (params.action === 'list') {
                if (environments.size === 0) return said('Nothing attached. Everything runs locally.');
                const lines = [...environments.values()].map(
                    (e) => `${e.name === current ? '*' : ' '} ${e.name}  ${e.host}  ${e.connection.alive ? 'up' : 'gone'}`,
                );
                return said(`Attached environments (* is current):\n${lines.join('\n')}`);
            }

            if (params.action === 'default') {
                const target = params.target ?? 'local';
                if (target === 'local') {
                    current = null;
                    dead = null;
                    published[PUBLISHED] = undefined;
                    await announce(null);
                    return said('Working locally.');
                }
                const chosen = environments.get(target);
                if (chosen === undefined) return said(`No environment called ${target}. Connect it first.`);
                current = target;
                dead = null;
                await announce(chosen);
                return said(`Working on ${target}.`);
            }

            if (params.target === undefined) return said('connect needs a target: user@host.');
            try {
                const name = params.name ?? parseTarget(params.target).host.split('@').pop() ?? params.target;
                const environment = await attach(name, params.target, () => {});
                const where = await environment.connection.request({ kind: 'cwd' });
                const at = where.kind === 'cwd' ? where.path : 'unknown';
                return said(`Attached ${name} (${params.target}), working directory ${at}. Tools now act there.`);
            } catch (error) {
                return said(`Could not attach: ${(error as Error).message}`);
            }
        },
    });

    // ── the command, for the person ────────────────────────────────────────
    pi.registerCommand('environment', {
        description: 'work on another machine: /environment connect user@host, /environment default local',
        getArgumentCompletions: (prefix) => {
            const words = ['connect', 'default', ...environments.keys(), 'local'];
            const found = words.filter((word) => word.startsWith(prefix));
            return found.length > 0 ? found.map((word) => ({ value: word, label: word })) : null;
        },
        handler: async (args, ctx) => {
            const [verb, rest] = args.trim().split(/\s+/, 2);

            if (verb === undefined || verb === '') {
                const where = current === null ? 'local' : current;
                const attached = [...environments.keys()].join(', ') || 'none';
                ctx.ui.notify(`Working in ${where}. Attached: ${attached}.`, 'info');
                return;
            }

            if (verb === 'default') {
                const target = rest ?? 'local';
                if (target === 'local') {
                    current = null;
                    dead = null;
                    published[PUBLISHED] = undefined;
                    await announce(null);
                    ctx.ui.notify('Working locally.', 'info');
                    return;
                }
                const chosen = environments.get(target);
                if (chosen === undefined) {
                    ctx.ui.notify(`No environment called ${target}.`, 'error');
                    return;
                }
                current = target;
                dead = null;
                await announce(chosen);
                ctx.ui.notify(`Working on ${target}.`, 'info');
                return;
            }

            if (verb === 'connect') {
                // Using the command means this session works elsewhere, so the
                // agent should be able to move it too.
                load();
                if (rest === undefined) {
                    ctx.ui.notify('Give a target: /environment connect user@host', 'error');
                    return;
                }
                const name = parseTarget(rest).host.split('@').pop() ?? rest;
                try {
                    await attach(name, rest, (note) => ctx.ui.notify(note, 'info'));
                    ctx.ui.notify(`Attached ${name}. Tools now act there; /environment default local comes back.`, 'info');
                } catch (error) {
                    ctx.ui.notify(`Could not attach: ${(error as Error).message}`, 'error');
                }
                return;
            }

            ctx.ui.notify('Usage: /environment connect user@host | /environment default <name|local>', 'error');
        },
    });

    // Out of the prompt until wanted.
    //
    // Not on a timer: a timer fires while pi is still loading extensions, and
    // action methods throw there ("Extension runtime not initialized"), taking
    // the whole session down. before_agent_start is the first moment the
    // runtime is up, and the flag means a tool loaded on purpose is not taken
    // away again on the next turn.
    let hidden = false;
    pi.on('before_agent_start', async () => {
        if (hidden) return;
        hidden = true;
        pi.setActiveTools(pi.getActiveTools().filter((name) => !OWN.includes(name)));
    });

    pi.on('session_shutdown', async () => {
        for (const environment of environments.values()) environment.connection.close();
        environments.clear();
        current = null;
        published[PUBLISHED] = undefined;
    });
}
