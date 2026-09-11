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
import { operationsFor } from './lib/remote/client';
import type { Connection } from './lib/remote/client';
import { deploy, parseTarget } from './lib/remote/deploy';

interface Environment {
    readonly name: string;
    readonly connection: Connection;
    readonly host: string;
}

export default function (pi: ExtensionAPI) {
    const environments = new Map<string, Environment>();
    let current: string | null = null;

    const active = (): Environment | null => (current === null ? null : (environments.get(current) ?? null));

    /** A connection that has died stops being current, rather than being addressed. */
    const forget = (name: string, why: string): void => {
        environments.delete(name);
        if (current === name) current = null;
        pi.sendMessage(
            {
                customType: 'environment',
                content: `The environment ${name} is gone: ${why}. Commands run locally again; anything it was holding is lost.`,
                display: true,
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
                const environment = active();
                if (environment === null) return (local.execute as (...a: never[]) => unknown)(...args);
                const remote = make(operationsFor(environment.connection));
                return (remote.execute as (...a: never[]) => unknown)(...args);
            },
        }) as T;

    pi.registerTool(route(localRead, (ops) => createReadTool(process.cwd(), { operations: ops.read })));
    pi.registerTool(route(localWrite, (ops) => createWriteTool(process.cwd(), { operations: ops.write })));
    pi.registerTool(route(localEdit, (ops) => createEditTool(process.cwd(), { operations: ops.edit })));
    pi.registerTool(route(localBash, (ops) => createBashTool(process.cwd(), { operations: ops.bash })));

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
                    return said('Working locally.');
                }
                if (!environments.has(target)) return said(`No environment called ${target}. Connect it first.`);
                current = target;
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
                    ctx.ui.notify('Working locally.', 'info');
                    return;
                }
                if (!environments.has(target)) {
                    ctx.ui.notify(`No environment called ${target}.`, 'error');
                    return;
                }
                current = target;
                ctx.ui.notify(`Working on ${target}.`, 'info');
                return;
            }

            if (verb === 'connect') {
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

    pi.on('session_shutdown', async () => {
        for (const environment of environments.values()) environment.connection.close();
        environments.clear();
        current = null;
    });
}
