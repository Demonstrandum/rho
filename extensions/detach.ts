// /detach: the interface goes away and the session keeps running.
//
// Overnight sessions were kept alive by leaving pi inside tmux, which is a
// second thing to remember and a second place for the session to be. The
// machinery for a session that outlives its interface already exists for
// another machine: an agent behind a unix socket, and an interface that
// attaches to it. This is that, with the network taken out.
//
// The conversation moves by its file rather than by copying anything: pi
// writes every turn to a session file as it goes, so the daemon starts on that
// same file and continues it. What cannot move is a turn in flight, so
// detaching waits for the agent to settle.
//
// /exit still ends the session. ctrl+d detaches, ctrl+c twice ends, which is
// the distinction tmux was standing in for.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeLastWord } from './lib/complete-words';
import { fileURLToPath } from 'node:url';
import { rhoRoot } from './lib/rho-root';

/** Where the runner and its sockets live on this machine. */
const RUNNER = join(homedir(), '.cache', 'rho', 'remote', 'session-runner.js');
const SOCKETS = join(homedir(), '.cache', 'rho', 'sessions');

/** A name a socket file can be called, and a person can type again. */
export function nameFor(given: string | undefined, fallback: string): string {
    const cleaned = (given ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    return cleaned === '' ? fallback : cleaned;
}

/** What a session started from here is called when nobody says. */
export function suggestedName(cwd: string, when: Date): string {
    const place = cwd.split('/').filter((part) => part !== '').pop() ?? 'session';
    const clock = `${String(when.getHours()).padStart(2, '0')}${String(when.getMinutes()).padStart(2, '0')}`;
    return nameFor(`${place}-${clock}`, 'session');
}

/** What a name on this machine refers to, when nothing is running under it. */
export interface Kept {
    readonly file: string;
    readonly cwd: string;
}

const keptFile = (name: string): string =>
    join(homedir(), '.local', 'state', 'rho', 'sessions', name, 'local.json');

export function remember(name: string, kept: Kept): void {
    mkdirSync(dirname(keptFile(name)), { recursive: true });
    writeFileSync(keptFile(name), `${JSON.stringify({ version: 1, ...kept }, null, 2)}\n`);
}

export function recall(name: string): Kept | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(keptFile(name), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return null;
        const held = parsed as Partial<Kept>;
        if (typeof held.file !== 'string' || typeof held.cwd !== 'string') return null;
        return { file: held.file, cwd: held.cwd };
    } catch {
        return null;
    }
}

/** Names this machine has a transcript for, running or not. */
export const keptHere = (): string[] => {
    try {
        return readdirSync(join(homedir(), '.local', 'state', 'rho', 'sessions')).filter(
            (name) => recall(name) !== null,
        );
    } catch {
        return [];
    }
};

/** The sessions this machine is holding, named as they can be typed. */
export const runningHere = (): string[] => {
    try {
        return readdirSync(SOCKETS)
            .filter((file) => file.endsWith('.sock'))
            .map((file) => file.slice(0, -'.sock'.length));
    } catch {
        // No directory means none have ever run here, which is not a fault.
        return [];
    }
};

/**
 * What pi says on the way out, plus the way back to a session that is still up.
 *
 * pi prints "To resume this session: pi --session <id>" from its own shutdown,
 * which does not run when an extension leaves by itself, so the line is
 * rebuilt here rather than lost. The id resumes the transcript in a new
 * process; the name attaches to the agent that is still running on it, which
 * is the difference detaching makes and the reason both are printed.
 */
export function resumeLines(ctx: ExtensionContext, name: string | undefined): readonly string[] {
    const id = ctx.sessionManager.getSessionId();
    const lines: string[] = [];
    if (id !== undefined && id !== '') lines.push(`To resume this session: pi --session ${id}`);
    if (name !== undefined && name !== '') lines.push(`Or attach it by name:   ${attachCommand(name)}`);
    return lines;
}

/** The shell command that draws a session that is still running. */
export function attachCommand(name: string): string {
    // The url, not import.meta.dir: rhoRoot takes a file and starts from its
    // directory, so handing it a directory starts a level too high and the
    // walk misses the checkout entirely.
    const client = join(rhoRoot(fileURLToPath(import.meta.url)), 'bin', 'rho-remote');
    return existsSync(client) ? `bun ${client} local ${name}` : `/attach ${name}`;
}

export default function (pi: ExtensionAPI) {
    /**
     * An interface onto a session that is already behind a socket.
     *
     * There the session needs no handing over: it is already running without
     * this interface, and detaching means closing the interface and leaving it
     * where it is. Handing it over again would start a second agent on one
     * conversation.
     */
    const attached = (): boolean => process.env.RHO_REMOTE_CLIENT === '1';

    /**
     * Leave, without leaving the terminal in pi's mode.
     *
     * process.exit runs no cleanup, so the terminal keeps raw mode, bracketed
     * paste and the kitty keyboard protocol, and the next keystrokes arrive as
     * escape sequences printed into the shell (`0;1:3u` and friends) with half
     * a prompt still on screen. tui.stop puts all of it back, and it is
     * reached the way pi's own external-editor handoff reaches it.
     *
     * The wait exists because shutdown is deferred to the next idle moment,
     * which from a key handler has not always arrived: the interface stayed up
     * while the daemon waited for it, which is the one state a detach must not
     * leave behind. A shutdown that does land exits first and this never runs.
     */
    const leave = (ctx: ExtensionContext, after: number, farewell: readonly string[] = []): void => {
        ctx.shutdown();
        const timer = setTimeout(() => {
            void ctx.ui
                .custom<void>((tui, _theme, _keys, done) => {
                    tui.stop();
                    done();
                    return { render: () => [], handleInput: () => {} } as never;
                })
                .finally(() => {
                    // After the terminal is its own again, so the lines stay
                    // on screen rather than being wiped by the restore, and in
                    // the shape pi leaves behind on its own exit.
                    for (const line of farewell) process.stdout.write(`${line}\n`);
                    process.exit(0);
                });
        }, after);
        // A process that is on its way out anyway should not be held open by
        // this timer alone.
        timer.unref?.();
    };

    const detach = async (ctx: ExtensionContext, asked: string | undefined): Promise<void> => {
        if (attached()) {
            (globalThis as { __rho_detaching?: boolean }).__rho_detaching = true;
            leave(ctx, 1_000, resumeLines(ctx, process.env.RHO_SESSION_NAME));
            return;
        }

        // pi writes the session file as the first turn happens, so a session
        // nobody has spoken to has nothing to hand over -- and nothing worth
        // keeping alive either. There ctrl+d means what it means everywhere
        // else in a terminal: leave. Reporting it as an obstacle turns the
        // usual way out of an empty session into a message about detaching.
        const file = ctx.sessionManager.getSessionFile();
        if (file === undefined || !existsSync(file)) {
            // Nothing was handed over, so nothing is waiting on this process
            // and the wait is only as long as pi needs to go on its own. There
            // is no name to attach to, so the farewell is pi's own line.
            leave(ctx, 300, resumeLines(ctx, undefined));
            return;
        }
        if (!existsSync(RUNNER)) {
            ctx.ui.notify('The session runner is not built here yet: /remote create builds it.', 'error');
            return;
        }

        // A name, because resuming by uuid is not resuming by hand.
        const given =
            asked ?? (await ctx.ui.input('Name this session', suggestedName(ctx.sessionManager.getCwd(), new Date())));
        if (given === undefined) return;
        const name = nameFor(given, suggestedName(ctx.sessionManager.getCwd(), new Date()));

        const already = spawnSync('bun', [RUNNER, 'all'], { encoding: 'utf8' })
            .stdout?.split('\n')
            .some((line) => line.split('\t')[0] === name && line.includes('running'));
        if (already === true) {
            ctx.ui.notify(`${name} is already a session that is running here. Pick another name.`, 'error');
            return;
        }

        // The daemon takes the conversation over from the file, so what it
        // continues is this session and not a copy of it. It waits for this
        // process to exit first: two pi processes appending to one session file
        // would interleave two conversations into it.
        const started = spawnSync(
            'bun',
            [
                RUNNER,
                'serve',
                name,
                ctx.sessionManager.getCwd(),
                '--after-pid',
                String(process.pid),
                '--',
                '--session',
                file,
            ],
            { encoding: 'utf8', input: JSON.stringify({ auth: null, env: {} }) },
        );
        if (started.status !== 0) {
            ctx.ui.notify(`Could not keep it running: ${(started.stderr ?? '').trim().split('\n').pop() ?? ''}`, 'error');
            return;
        }

        // What the name refers to, written down where a later process can read
        // it. Without this a session that stopped -- by hand, or by the idle
        // retirement after six hours -- took its name with it: the socket was
        // the only record that the name existed, and the transcript was a uuid
        // nobody had written down.
        remember(name, { file, cwd: ctx.sessionManager.getCwd() });

        leave(ctx, 1_500, [
            `${name} keeps running here.`,
            ...resumeLines(ctx, name),
        ]);
    };

    pi.registerCommand('detach', {
        description: 'leave this session running without an interface: /detach [name]',
        handler: async (args: string, ctx: ExtensionContext) => detach(ctx, args.trim() === '' ? undefined : args.trim()),
    });

    pi.registerCommand('attach', {
        description: 'come back to a session left running here: /attach <name>',
        getArgumentCompletions: (text) =>
            completeLastWord(
                text,
                [...new Set([...runningHere(), ...keptHere()])].map((name) => ({ value: name })),
            ),
        handler: async (args: string, ctx: ExtensionContext) => {
            const name = args.trim();
            const running = runningHere();
            if (name === '') {
                const idle = keptHere().filter((held) => !running.includes(held));
                ctx.ui.notify(
                    running.length === 0 && idle.length === 0
                        ? 'Nothing is running here. /detach leaves the current session running.'
                        : `Running here: ${running.join(', ') || 'none'}${idle.length === 0 ? '' : `. Stopped: ${idle.join(', ')}`}`,
                    'info',
                );
                return;
            }
            if (!running.includes(name)) {
                // Stopping is not forgetting here either: a session retired
                // for being idle is started again on its own transcript.
                const kept = recall(name);
                if (kept === null) {
                    const known = [...new Set([...running, ...keptHere()])];
                    ctx.ui.notify(`No session called ${name} here. Known: ${known.join(', ') || 'none'}`, 'error');
                    return;
                }
                const started = spawnSync(
                    'bun',
                    [RUNNER, 'serve', name, kept.cwd, '--', '--session', kept.file],
                    { encoding: 'utf8', input: JSON.stringify({ auth: null, env: {} }) },
                );
                if (started.status !== 0) {
                    ctx.ui.notify(
                        `Could not start ${name} again: ${(started.stderr ?? '').trim().split('\n').pop() ?? ''}`,
                        'error',
                    );
                    return;
                }
            }
            // The interface for it is a separate process, as it is for a
            // session on another machine, and this one stands aside for it.
            const client = join(rhoRoot(fileURLToPath(import.meta.url)), 'bin', 'rho-remote');
            await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
                queueMicrotask(() => {
                    tui.stop();
                    try {
                        spawnSync('bun', [client, 'local', name], { stdio: 'inherit' });
                    } finally {
                        tui.start();
                        tui.requestRender(true);
                        done();
                    }
                });
                return { render: () => [], handleInput: () => {} } as never;
            }, { overlay: true });
        },
    });

    /**
     * ctrl+d leaves it running, ctrl+c twice ends it.
     *
     * pi's own ctrl+d exits, which is the thing tmux was there to prevent.
     */
    pi.registerShortcut('ctrl+d', {
        description: 'detach: leave this session running without an interface',
        handler: async (ctx: ExtensionContext) => {
            if ((ctx.ui.getEditorText() ?? '') !== '') return;
            await detach(ctx, undefined);
        },
    });
}
