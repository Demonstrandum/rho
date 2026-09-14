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
import { completeLastWord } from './lib/complete-words';
import { operationsFor, waitFor } from './lib/remote/client';
import type { Connection } from './lib/remote/client';
import { deploy } from './lib/remote/deploy';
import { addressName, parseAddress, parseLocated, sshTarget } from './lib/remote/address';
import type { Address } from './lib/remote/address';
import { PersistedState } from './lib/state-store';

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
    /** the branch checked out there, when the directory is a work tree. */
    branch?: string | null;
    readonly shell: string;
    readonly alive: boolean;
    chdir(path: string): Promise<string>;
}

const PUBLISHED = '__rho_environment';
const published = globalThis as typeof globalThis & { [PUBLISHED]?: Where | undefined };

export const currentEnvironment = (): Where | undefined => published[PUBLISHED];

/** What a session remembers about where it was working. */
interface Remembered {
    readonly version: 1;
    readonly host: string | null;
    readonly name: string | null;
    readonly cwd: string | null;
}

const parseRemembered = (raw: unknown): Remembered | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const value = raw as Record<string, unknown>;
    if (value.version !== 1) return null;
    return {
        version: 1,
        host: typeof value.host === 'string' ? value.host : null,
        name: typeof value.name === 'string' ? value.name : null,
        cwd: typeof value.cwd === 'string' ? value.cwd : null,
    };
};

export default function (pi: ExtensionAPI) {
    const environments = new Map<string, Environment>();
    let current: string | null = null;
    let memory: PersistedState<Remembered> | null = null;

    const remember = (): void => {
        const state = published[PUBLISHED];
        memory?.write({
            version: 1,
            host: state?.host ?? null,
            name: state?.name ?? null,
            cwd: state?.cwd ?? null,
        });
    };

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
            // A machine that went away is still where this session was working,
            // so a resume offers it rather than forgetting it happened.
            memory?.write({ version: 1, host: environments.get(name)?.host ?? name, name, cwd: null });
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
                    'bash, read, write and edit act on this machine, with no argument needed:',
                    'pass bash\u2019s on, or address a path, only to reach a different machine.',
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

    const attach = async (name: string, text: string, note: (text: string) => void): Promise<Environment> => {
        const address = parseAddress(text);
        if (address === null) throw new Error(`not a machine address: ${text}`);
        const connection = await deploy(address, { onProgress: note });
        const environment: Environment = { name, connection, host: sshTarget(address) };
        connection.onEvent((event) => {
            if (event.kind === 'gone') forget(name, event.why);
        });
        environments.set(name, environment);
        current = name;
        dead = null;
        await announce(environment);
        remember();
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
    // parseLocated is the parser; this file no longer has one of its own.

    /** The connection for an address, reusing an attachment when there is one. */
    const connectionFor = async (address: Address): Promise<Connection> => {
        const host = sshTarget(address);
        for (const environment of environments.values()) {
            if (environment.host === host && environment.connection.alive) return environment.connection;
        }
        // Reachable without becoming current. One addressed path, or one
        // command with `on`, must not move the session: doing that through
        // attach() meant a single `uname -a` elsewhere switched everything
        // after it to that machine, which is what /environment is for.
        const name = addressName(address);
        const connection = await deploy(address, {});
        const environment: Environment = { name, connection, host };
        connection.onEvent((event) => {
            if (event.kind === 'gone') {
                environments.delete(name);
                if (current === name) forget(name, event.why);
            }
        });
        environments.set(name, environment);
        return connection;
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

    /**
     * The machine is shown by the row, not added to the output.
     *
     * A line prepended to a tool result is noise in the model's context and
     * ugly on screen. tool-rows puts the machine on the right of the call row
     * instead, taken from the call's own arguments, which carry it only when
     * the target differs from the session's.
     */

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
                const located = typeof params?.path === 'string' ? parseLocated(params.path) : null;
                if (located !== null && located.where.kind !== 'current') {
                    (params as { path: string }).path = located.path;
                    if (located.where.kind === 'local') {
                        return (local.execute as (...a: never[]) => unknown)(...args);
                    }
                    const address = located.where.address;
                    const connection = await connectionFor(address);
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
    /**
     * bash, with the machine as an optional argument.
     *
     * A path can carry its machine; a command cannot, so without this the only
     * way to run one command elsewhere is to move the session and move it
     * back, which changes where every later command goes as a side effect of
     * wanting one. `on` says where this one runs and nothing else changes.
     *
     * It takes a name that is already attached, a user@host to attach on
     * demand, or "local". An unattached host is connected to, because refusing
     * to do the obvious thing and asking the caller to attach first is a worse
     * answer than doing it.
     */
    const bashParameters = Type.Object({
        command: Type.String({ description: 'Shell command to execute' }),
        timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
        on: Type.Optional(
            Type.String({
                description:
                    'Where to run it: an attached environment name, a user@host to attach on demand, or "local". Omit it to run where the session already points, which is the usual case: pass it only to run one command somewhere other than the current environment.',
            }),
        ),
    });

    pi.registerTool({
        ...localBash,
        parameters: bashParameters,
        promptGuidelines: [
            'Omit bash\u2019s on argument unless the command must run somewhere other than the current environment: passing the machine the session already points at repeats what the environment block says and reads as though it changed something.',
        ],
        description:
            `${localBash.description ?? ''} Pass "on" to run this one command somewhere else: an attached ` +
            'environment name, a user@host to attach on demand, or "local" for the machine this session ' +
            'runs on. Without it, the command runs wherever the environment tool currently points.',
        async execute(id: string, params: { command: string; timeout?: number; on?: string }, ...rest: never[]) {
            const { on, ...forwarded } = params;
            // The wrapped tool's own result type, which this returns unchanged.
            type Result = Awaited<ReturnType<typeof localBash.execute>>;
            // `on` is stripped before the wrapped tool sees it: pi's bash
            // knows nothing about it, and the row renderer reads it from the
            // call rather than from the output.
            const run = (tool: typeof localBash): Promise<Result> =>
                (tool.execute as (...a: never[]) => Promise<Result>)(id as never, forwarded as never, ...rest);

            const chosen = async (): Promise<Connection | null> => {
                if (on === undefined) return null;
                if (on === 'local') return null;
                const attached = environments.get(on);
                if (attached !== undefined) {
                    if (!attached.connection.alive) throw new Error(`the connection to ${on} is closed`);
                    return attached.connection;
                }
                if (!on.includes('@')) {
                    throw new Error(
                        `no environment called ${on}. Give a user@host to attach to, or "local", or one of: ` +
                            `${[...environments.keys()].join(', ') || 'nothing attached'}`,
                    );
                }
                const address = parseAddress(on);
                if (address === null) throw new Error(`not a machine address: ${on}`);
                return connectionFor(address);
            };

            const connection = await chosen();
            if (on === 'local') return run(localBash);
            if (connection !== null) {
                return run(createBashTool(process.cwd(), { operations: operationsFor(connection).bash }));
            }

            // No `on`: the current environment decides, with the same refusals
            // as every other tool.
            if (dead !== null) {
                throw new Error(
                    `the environment ${dead.name} is gone (${dead.why}), so this did not run. ` +
                        'Reconnect it, pass on to choose a machine, or environment default local.',
                );
            }
            const environment = active();
            if (environment === null) return run(localBash);
            if (!environment.connection.alive) {
                throw new Error(`the connection to ${environment.name} is closed, so this did not run`);
            }
            return run(createBashTool(process.cwd(), { operations: operationsFor(environment.connection).bash }));
        },
    });

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
                    remember();
                    await announce(null);
                    return said('Working locally.');
                }
                const chosen = environments.get(target);
                if (chosen === undefined) return said(`No environment called ${target}. Connect it first.`);
                current = target;
                dead = null;
                await announce(chosen);
                remember();
                return said(`Working on ${target}.`);
            }

            if (params.target === undefined) return said('connect needs a target: user@host.');
            try {
                const parsed = parseAddress(params.target);
                if (parsed === null) return said(`not a machine address: ${params.target}`);
                const name = params.name ?? addressName(parsed);
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
        description:
            'work on another machine: /environment user@host to attach, /environment local to come back, /environment drop <name> to close one',
        getArgumentCompletions: (prefix) => {
            // Everything offered here is something the handler accepts. The
            // list used to include `local` while only `default local` worked,
            // which is a completion that teaches a command that does not exist.
            const words = ['local', ...environments.keys(), 'connect', 'default', 'drop', 'list'];
            // Whole lines: pi replaces the argument text with the value it is
            // given, so `/environment drop <tab>` on a bare word would leave
            // the name without the verb. See lib/complete-words.ts.
            return completeLastWord(prefix, words.map((word) => ({ value: word })));
        },
        handler: async (args, ctx) => {
            const [verb, rest] = args.trim().split(/\s+/, 2);

            if (verb === undefined || verb === '') {
                const where = current === null ? 'local' : current;
                const attached = [...environments.keys()].join(', ') || 'none';
                ctx.ui.notify(
                    `Working in ${where}. Attached: ${attached}. ` +
                        '/environment local, /environment <name>, /environment user@host, /environment drop <name>',
                    'info',
                );
                return;
            }

            // The short forms, because they are what a person types: a bare
            // name switches to it, a bare address attaches it, and `local`
            // comes back here. `connect` and `default` still work.
            if (verb === 'local' || (verb === 'connect' && rest === 'local') || (verb === 'default' && rest === undefined)) {
                current = null;
                dead = null;
                published[PUBLISHED] = undefined;
                remember();
                await announce(null);
                ctx.ui.notify('Working locally.', 'info');
                return;
            }

            if (verb === 'drop') {
                const name = rest ?? current;
                const held = name === null ? undefined : environments.get(name);
                if (name === null || held === undefined) {
                    ctx.ui.notify(`No environment called ${name ?? '(none given)'}.`, 'error');
                    return;
                }
                held.connection.close();
                environments.delete(name);
                if (current === name) {
                    current = null;
                    dead = null;
                    published[PUBLISHED] = undefined;
                    remember();
                    await announce(null);
                }
                ctx.ui.notify(`Closed ${name}. Working locally.`, 'info');
                return;
            }

            if (verb === 'list') {
                const lines = [...environments.values()].map(
                    (e) => `${e.name === current ? '*' : ' '} ${e.name}  ${e.host}  ${e.connection.alive ? 'up' : 'gone'}`,
                );
                ctx.ui.notify(lines.join('\n') || 'Nothing attached.', 'info');
                return;
            }

            if (verb !== 'connect' && verb !== 'default' && environments.has(verb)) {
                const chosen = environments.get(verb);
                if (chosen !== undefined) {
                    current = verb;
                    dead = null;
                    await announce(chosen);
                    remember();
                    ctx.ui.notify(`Working on ${verb}.`, 'info');
                    return;
                }
            }

            // A bare address is an attach, so `/environment samuel@host` does
            // what it looks like it does.
            if (verb !== 'connect' && verb !== 'default' && verb.includes('@')) {
                load();
                const parsed = parseAddress(verb);
                if (parsed === null) {
                    ctx.ui.notify(`not a machine address: ${verb}`, 'error');
                    return;
                }
                const name = addressName(parsed);
                try {
                    await attach(name, verb, (note) => ctx.ui.notify(note, 'info'));
                    ctx.ui.notify(`Attached ${name}. /environment local comes back.`, 'info');
                } catch (error) {
                    // Refused, not quietly left here. Asking to work on another
                    // machine and being given this one is the failure that
                    // matters: a node allocated a minute ago whose host key was
                    // unknown left the tools on the laptop, and the next
                    // command ran here as though nothing had happened.
                    dead = { name, why: (error as Error).message };
                    current = null;
                    published[PUBLISHED] = undefined;
                    remember();
                    ctx.ui.notify(
                        `Could not attach ${name}: ${(error as Error).message}. ` +
                            `Commands are refused until this works or /environment local is asked for.`,
                        'error',
                    );
                }
                return;
            }

            if (verb === 'default') {
                const target = rest ?? 'local';
                if (target === 'local') {
                    current = null;
                    dead = null;
                    published[PUBLISHED] = undefined;
                    remember();
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
                remember();
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
                const parsedRest = parseAddress(rest);
                if (parsedRest === null) {
                    ctx.ui.notify(`not a machine address: ${rest}`, 'error');
                    return;
                }
                const name = addressName(parsedRest);
                try {
                    await attach(name, rest, (note) => ctx.ui.notify(note, 'info'));
                    ctx.ui.notify(`Attached ${name}. Tools now act there; /environment default local comes back.`, 'info');
                } catch (error) {
                    // Refused, not quietly left here. Asking to work on another
                    // machine and being given this one is the failure that
                    // matters: a node allocated a minute ago whose host key was
                    // unknown left the tools on the laptop, and the next
                    // command ran here as though nothing had happened.
                    dead = { name, why: (error as Error).message };
                    current = null;
                    published[PUBLISHED] = undefined;
                    remember();
                    ctx.ui.notify(
                        `Could not attach ${name}: ${(error as Error).message}. ` +
                            `Commands are refused until this works or /environment local is asked for.`,
                        'error',
                    );
                }
                return;
            }

            // Naming what was typed, since the usual reason to land here is a
            // name that is not attached rather than a verb nobody knows.
            const attached = [...environments.keys()].join(', ') || 'nothing attached';
            ctx.ui.notify(
                `"${verb}" is not an environment or a host. Attached: ${attached}.\n` +
                    '/environment user@host attaches, /environment <name> switches, /environment local comes back, /environment drop <name> closes one.',
                'error',
            );
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

    /**
     * A resumed session is not where it left off.
     *
     * The connection died with the process, so the session comes back on the
     * laptop while its history is full of another machine. Saying nothing
     * leaves the model reading commands that ran somewhere it no longer is:
     * this asks, and then states the answer, so the change is in the
     * conversation either way.
     */
    pi.on('session_start', async (event, ctx) => {
        memory = PersistedState.open(
            { name: 'environment', scope: 'session', parse: parseRemembered },
            { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
        );
        const last = memory.read();
        if (last?.host == null) return;
        const where = last.host;

        if (!ctx.hasUI) {
            pi.sendMessage(
                {
                    customType: 'environment',
                    content:
                        `<environment>\nworking locally on this machine\n` +
                        `this session was working on ${where} before it stopped, and that connection is gone.\n` +
                        `environment connect ${where} attaches it again\n</environment>`,
                    display: true,
                },
                { deliverAs: 'followUp' },
            );
            return;
        }

        const RECONNECT = `reconnect to ${where}`;
        const LOCAL = 'work on this machine';
        const ELSEWHERE = 'connect somewhere else';
        const choice = await ctx.ui.select(
            `this session was working on ${where}. that connection did not survive.`,
            [RECONNECT, LOCAL, ELSEWHERE],
        );

        if (choice === RECONNECT) {
            try {
                const environment = await attach(last.name ?? where, where, (note) => ctx.ui.notify(note, 'info'));
                if (last.cwd !== null) {
                    const moved = await environment.connection.request({ kind: 'chdir', path: last.cwd });
                    if (moved.kind === 'cwd') {
                        const state = published[PUBLISHED];
                        if (state !== undefined) state.cwd = moved.path;
                    }
                }
            } catch (error) {
                ctx.ui.notify(`could not reconnect: ${(error as Error).message}`, 'error');
                await announce(null);
            }
            return;
        }

        if (choice === ELSEWHERE) {
            const target = await ctx.ui.input('connect to', 'user@host or user@host:/path');
            if (typeof target === 'string' && target.trim() !== '') {
                const trimmed = target.trim();
                try {
                    const chosenAddress = parseAddress(trimmed);
                    if (chosenAddress === null) {
                        ctx.ui.notify(`not a machine address: ${trimmed}`, 'error');
                        return;
                    }
                    await attach(addressName(chosenAddress), trimmed, (note) => ctx.ui.notify(note, 'info'));
                } catch (error) {
                    ctx.ui.notify(`could not attach: ${(error as Error).message}`, 'error');
                    await announce(null);
                }
                return;
            }
        }

        // Chose the laptop, or cancelled: the session has moved, so it is said.
        current = null;
        dead = null;
        published[PUBLISHED] = undefined;
        remember();
        await announce(null);
    });

    pi.on('session_shutdown', async () => {
        for (const environment of environments.values()) environment.connection.close();
        environments.clear();
        current = null;
        published[PUBLISHED] = undefined;
    });
}
