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
import { Text } from '@earendil-works/pi-tui';
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

    /**
     * One line on screen, the facts underneath for the model.
     *
     * The default renderer prints the customType as a label and then the raw
     * content, so an xml block meant for the model arrives on screen as
     * "[environment] <environment> ..." with its own tags and a blank line
     * either side. The person needs to know which machine they are on; the
     * tags are for the reader that parses them.
     */
    pi.registerMessageRenderer('environment', (message, options, theme) => {
        const details = message.details as { host?: string; cwd?: string; shell?: string } | undefined;
        const line =
            details?.host === undefined
                ? `${theme.fg('accent', 'environment')}  ${theme.fg('dim', 'local')}`
                : [
                      theme.fg('accent', 'environment'),
                      theme.fg('text', details.host),
                      theme.fg('dim', details.cwd ?? ''),
                      theme.fg('dim', (details.shell ?? '').split('/').pop() ?? ''),
                  ].join('  ');
        // Expanded shows what the model was told, which is the thing worth
        // checking when it behaves as though it is on the wrong machine.
        const content = typeof message.content === 'string' ? message.content : '';
        const text = options.expanded ? `${line}\n${theme.fg('dim', content)}` : line;
        return new Text(text, options.outputPad, 0);
    });

    /** Said out loud, because a change of machine the model cannot see is a trap. */
    const announce = async (environment: Environment | null): Promise<void> => {
        // The context-mode prompt tells the model to prefer ctx_batch_execute
        // over bash, and that advice is wrong here: those tools run on this
        // machine whatever is attached. Saying so where the switch is
        // announced is the only place the model reads both facts together.
        if (environment === null) {
            pi.sendMessage(
                {
                    customType: 'environment',
                    content:
                        '<environment>\nworking locally on this machine\nevery tool acts here, including ctx_execute and ctx_batch_execute\n</environment>',
                    display: true,
                },
                { deliverAs: 'followUp' },
            );
            return;
        }

        const facts = await describe(environment);
        const state = published[PUBLISHED];
        pi.sendMessage(
            {
                customType: 'environment',
                content: [
                    '<environment>',
                    facts,
                    'bash, read, write and edit act on this machine.',
                    'ctx_execute, ctx_execute_file and ctx_batch_execute do not: they run on the',
                    'laptop and are refused while this is attached, whatever the context-mode',
                    'guidance says. use bash for commands here.',
                    '</environment>',
                ].join('\n'),
                display: true,
                // What the renderer draws, so the screen shows a line and the
                // model still gets the whole block.
                details: { host: environment.host, cwd: state?.cwd, shell: state?.shell },
            },
            { deliverAs: 'followUp' },
        );
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

    /**
     * `user@host:/path`, addressing one file on one machine.
     *
     * A path is only meaningful with a machine attached to it, and until now
     * that machine was always the current environment. This makes the pair
     * writable in one argument, so a file can be read from a node nothing is
     * attached to, or from the laptop while an environment is current, without
     * switching the session back and forth around a single read.
     *
     * `local:` is the way to name this machine, since a bare path means the
     * current environment.
     */
    const ADDRESSED = /^([A-Za-z0-9._-]+@[A-Za-z0-9._-]+|local):(\/.*)$/;

    /** The connection for an address, reusing an attachment when there is one. */
    const connectionFor = async (host: string): Promise<Connection> => {
        for (const environment of environments.values()) {
            if (environment.host === host && environment.connection.alive) return environment.connection;
        }
        const name = parseTarget(host).host.split('@').pop() ?? host;
        const environment = await attach(name, host, () => {});
        return environment.connection;
    };

    /**
     * Said in the tool's own description, because that is the only place the
     * model reads before choosing an argument. A syntax nothing documents is a
     * syntax nobody uses.
     */
    const ADDRESSING = [
        '',
        'Paths may name their machine: "user@host:/abs/path" reads or writes on that',
        'machine, attaching to it if nothing is attached yet, and "local:/abs/path"',
        'always means the machine this session runs on. A plain path means whichever',
        'machine the environment tool currently points at, so while an environment is',
        'attached, "local:" is how to reach a file here.',
    ].join(' ');

    const route = <T extends { execute: (...args: never[]) => unknown; description?: string }>(
        local: T,
        make: (operations: ReturnType<typeof operationsFor>) => T,
    ): T =>
        ({
            ...local,
            description:
                typeof local.description === 'string' ? `${local.description}${ADDRESSING}` : local.description,
            async execute(...args: never[]) {
                // An addressed path decides the machine by itself, before any
                // of the rules about the current environment apply.
                const params = args[1] as { path?: unknown } | undefined;
                const addressed =
                    typeof params?.path === 'string' ? ADDRESSED.exec(params.path) : null;
                if (addressed !== null) {
                    const [, where = '', path = ''] = addressed;
                    (params as { path: string }).path = path;
                    if (where === 'local') {
                        return (local.execute as (...a: never[]) => unknown)(...args);
                    }
                    const connection = await connectionFor(where);
                    const there = make(operationsFor(connection));
                    return (there.execute as (...a: never[]) => unknown)(...args);
                }

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
        if (/\benvironment\b|skill:remote|\bnodes\b|\bgpu\b/i.test(event.text)) load();
        return { action: 'continue' as const };
    });

    /**
     * Tools that run commands on this machine and cannot be routed.
     *
     * pi's own read, write, edit and bash are re-registered above and follow
     * the environment. An MCP tool cannot be: it is a separate process with no
     * idea another machine exists, so it runs here while everything around it
     * runs there. That is the wrong-machine failure again, with the added
     * insult that its output looks authoritative.
     */
    const RUNS_LOCALLY = /^(ctx_execute|ctx_execute_file|ctx_batch_execute)$/;

    pi.on('tool_call', async (event) => {
        if (active() === null && dead === null) return;
        if (!RUNS_LOCALLY.test(event.toolName)) return;
        const where = dead !== null ? `${dead.name} (gone)` : (current ?? 'elsewhere');
        return {
            block: true,
            reason:
                `${event.toolName} runs on this machine, not on ${where}, so it was not run. ` +
                'Use bash, read, write or edit, which act on the attached environment, ' +
                'or environment default local first if this really should run here.',
        };
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
            'To read or write one file on another machine, or on this one while an environment is attached, address the path as user@host:/abs/path or local:/abs/path rather than switching environment for a single file.',
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
