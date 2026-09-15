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
// same file and continues it. What cannot move is a turn in flight: the model
// call and any command it started belong to this process, and the daemon
// resumes the transcript rather than continuing them. So detaching mid-turn
// asks first, and ends the turn here, where ending it is written down.
//
// /exit still ends the session. ctrl+d detaches, ctrl+c twice ends, which is
// the distinction tmux was standing in for.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeLastWord } from './lib/complete-words';
import { fileURLToPath } from 'node:url';
import { rhoRoot } from './lib/rho-root';
import { attachable, offers, publishedConnect, remember, runningHere } from './lib/remote/sessions';
import type { Kept } from './lib/remote/sessions';

/** Where the runner lives on this machine. */
const RUNNER = join(homedir(), '.cache', 'rho', 'remote', 'session-runner.js');

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

/**
 * The shell command that draws a session that is still running.
 *
 * pi's own command line, because rho registers the flag on it. Printing a path
 * to a script inside a checkout, to be run under bun, is neither short nor
 * something anybody would type twice.
 */
export function attachCommand(name: string): string {
    return `pi --attach ${name}`;
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

    /**
     * A turn in flight cannot be handed over.
     *
     * The model call and any command it started belong to this process, and
     * what moves is the session file: the daemon resumes the transcript and
     * does not continue the turn that was running when the file was handed to
     * it. Detaching mid-turn used to do that silently, and the session came
     * back with the tool call in the transcript, no output under it, and
     * nothing running -- the streaming had not stopped so much as been left
     * behind.
     *
     * So the turn is ended here, where ending it is recorded: pi writes what
     * the assistant had written and marks the unfinished tool call aborted, so
     * the transcript the daemon picks up is a whole one.
     */
    const settled = async (ctx: ExtensionContext, within: number): Promise<boolean> => {
        const until = Date.now() + within;
        while (!ctx.isIdle() && Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return ctx.isIdle();
    };

    /** What to do about a turn that is running when somebody asks to leave. */
    const WAIT = 'let the turn finish, then detach';
    const STOP = 'stop the turn and detach now';
    const STAY = 'stay';

    /**
     * Whether the handover may go ahead now.
     *
     * `later` means the turn is being left to finish and the handover will run
     * itself when it does: a command streaming its output keeps streaming, the
     * transcript ends up whole, and reattaching finds the whole of it. Stopping
     * is offered because a turn can be long and leaving can be urgent, and it
     * is not the default, since what it costs is the work in flight.
     */
    const readyForHandover = async (
        ctx: ExtensionContext,
        what: string,
    ): Promise<'now' | 'later' | 'no'> => {
        if (ctx.isIdle()) return 'now';
        const choice = await ctx.ui.select(
            `A turn is running. It cannot be carried over: the model call and any command it started belong to this process, and ${what} resumes from the transcript.`,
            [WAIT, STOP, STAY],
        );
        if (choice === WAIT) return 'later';
        if (choice !== STOP) return 'no';
        ctx.abort();
        if (await settled(ctx, 10_000)) return 'now';
        ctx.ui.notify('The turn has not stopped yet. Try again in a moment.', 'error');
        return 'no';
    };

    /**
     * A detach asked for during a turn, waiting for the turn to end.
     *
     * Null when nothing is waiting; a string (possibly empty) is the name the
     * session was to be given. Typing again cancels it, because a person who
     * has started talking to the session is not leaving it.
     */
    let waitingToLeave: string | null | undefined;

    const detach = async (ctx: ExtensionContext, asked: string | undefined): Promise<void> => {
        if (attached()) {
            (globalThis as { __rho_detaching?: boolean }).__rho_detaching = true;
            leave(ctx, 1_000, resumeLines(ctx, process.env.RHO_SESSION_NAME));
            return;
        }

        // Before the file is looked for, because during the first turn there
        // is not one yet: pi writes the session file as that turn happens, so
        // ctrl+d landed in the empty-session branch and took the turn with it.
        const when = await readyForHandover(ctx, 'the session left running here');
        if (when === 'no') return;
        if (when === 'later') {
            waitingToLeave = asked ?? null;
            ctx.ui.notify('Detaching when this turn finishes. Anything typed before then cancels it.', 'info');
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
            { encoding: 'utf8', input: JSON.stringify({ auth: null }) },
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

    /**
     * `pi --attach <name>` and `pi --attach` for the picker.
     *
     * A flag rather than a path to a script: the way back to a session you
     * left running should be as short as the way into a new one, and
     * `bun /somewhere/rho/bin/rho-remote local <name>` is neither short nor
     * something anybody would guess. pi hands extensions its own command line,
     * so this is a flag on the command people already type.
     *
     * The interface for a detached session is a separate process, as it is for
     * a session on another machine, and this pi stands aside for it at
     * session_start and exits with it.
     */
    pi.registerFlag('attach', {
        description: 'attach to a session by name, here or on another machine (empty to be told which)',
        type: 'string',
    });

    pi.on('session_start', async (_event, ctx: ExtensionContext) => {
        const asked = pi.getFlag('attach');
        if (typeof asked !== 'string') return;
        // The bare flag when there is one candidate is that candidate: being
        // asked to choose between one thing is being asked for nothing.
        const only = offers();
        const name = asked === '' ? (only.length === 1 ? only[0]!.name : undefined) : asked;
        if (name === undefined) {
            ctx.ui.notify(
                only.length === 0
                    ? 'Nothing has been left running. /detach leaves this session running here, /remote create starts one elsewhere.'
                    : `Which one: ${only.map((offer) => `${offer.name} (${offer.detail})`).join(', ')}`,
                'info',
            );
            return;
        }
        await attachTo(ctx, name);
        ctx.shutdown();
        setTimeout(() => process.exit(0), 200);
    });

    /**
     * The turn asked to finish first has finished.
     *
     * agent_settled is pi's own "nothing more is coming": no retry, no
     * compaction, no queued follow-up. Detaching here hands over a transcript
     * with the whole turn in it, output of a long command included, which is
     * what reattaching then shows.
     */
    pi.on('agent_settled', async (_event, ctx: ExtensionContext) => {
        if (waitingToLeave === undefined) return;
        const name = waitingToLeave;
        waitingToLeave = undefined;
        await detach(ctx, name ?? undefined);
    });

    // Talking to the session is staying with it.
    pi.on('input', async () => {
        waitingToLeave = undefined;
        return undefined;
    });

    pi.registerCommand('detach', {
        description: 'leave this session running without an interface: /detach [name]',
        handler: async (args: string, ctx: ExtensionContext) => detach(ctx, args.trim() === '' ? undefined : args.trim()),
    });

    /**
     * Start this session again on the code that is on disk now.
     *
     * pi loads its extensions once, and it is itself a version: a session left
     * open across an edit, an upgrade or a package install goes on running
     * what it started with, and the change looks broken rather than absent.
     * pi's own /reload rebinds extensions in place, which covers an edit to
     * one of them and does not cover a new pi, a new dependency, or an
     * extension added since the session began.
     *
     * The conversation is not at risk: it is on disk after every turn, and
     * this hands the same file to the new process, so what comes back is this
     * session rather than a copy of it.
     */
    pi.registerCommand('restart', {
        description: 'start this session again on the current pi and rho, keeping the conversation',
        handler: async (_args: string, ctx: ExtensionContext) => {
            const file = ctx.sessionManager.getSessionFile();
            if (file === undefined || !existsSync(file)) {
                ctx.ui.notify('Nothing has been said in this session yet, so there is nothing to carry over.', 'info');
                return;
            }
            if (attached()) {
                ctx.ui.notify(
                    'This interface draws a session on another machine: /remote connect brings that one up to date, and this one is already the current rho.',
                    'info',
                );
                return;
            }
            const ready = await readyForHandover(ctx, 'the session that starts in its place');
            if (ready === 'later') {
                ctx.ui.notify('A restart cannot wait in the background: ask again when the turn has finished.', 'info');
                return;
            }
            if (ready === 'no') return;
            await ctx.ui.custom<void>(
                (tui, _theme, _keys, done) => {
                    queueMicrotask(() => {
                        tui.stop();
                        // The replacement owns the terminal while it runs, and
                        // this process is finished either way: a restart that
                        // returned here would leave two pi processes holding
                        // one session file.
                        const ran = spawnSync('pi', ['--session', file], { stdio: 'inherit', cwd: ctx.sessionManager.getCwd() });
                        done();
                        process.exit(ran.status ?? 0);
                    });
                    return { render: () => [], handleInput: () => {} } as never;
                },
                { overlay: true },
            );
        },
    });

    /**
     * Draw a session that is running here, starting it again if it stopped.
     *
     * The half of attaching that needs no network. What it is given has already
     * been resolved to this machine, so a name it cannot find is a session that
     * was running a moment ago and has since gone.
     */
    const drawHere = async (ctx: ExtensionContext, name: string, kept: Kept | null): Promise<void> => {
        if (!runningHere().includes(name)) {
            // Stopping is not forgetting here either: a session retired for
            // being idle is started again on its own transcript.
            if (kept === null) {
                ctx.ui.notify(`${name} is not running here any more, and left no transcript to start again.`, 'error');
                return;
            }
            const started = spawnSync('bun', [RUNNER, 'serve', name, kept.cwd, '--', '--session', kept.file], {
                encoding: 'utf8',
                input: JSON.stringify({ auth: null }),
            });
            if (started.status !== 0) {
                ctx.ui.notify(
                    `Could not start ${name} again: ${(started.stderr ?? '').trim().split('\n').pop() ?? ''}`,
                    'error',
                );
                return;
            }
        }
        // The interface for it is a separate process, as it is for a session
        // on another machine, and this one stands aside for it.
        const client = join(rhoRoot(fileURLToPath(import.meta.url)), 'bin', 'rho-remote');
        await ctx.ui.custom<void>(
            (tui, _theme, _keys, done) => {
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
            },
            { overlay: true },
        );
    };

    /**
     * Come back to a session by name, wherever it is.
     *
     * Shared by /attach and by `pi --attach`, so the two cannot drift, and it
     * dispatches rather than deciding: a name behind a socket here is drawn
     * here, and a name in the remote ledger is handed to /remote's own connect,
     * which knows what a session on another machine needs before it can be
     * drawn -- the runner updated, the session started if it has stopped, and
     * the host's rho compared with this machine's.
     */
    const attachTo = async (ctx: ExtensionContext, name: string): Promise<void> => {
        const found = attachable(name);
        if (found === null) {
            const known = offers();
            ctx.ui.notify(
                `No session called ${name}. Known: ${known.map((offer) => offer.name).join(', ') || 'none'}`,
                'error',
            );
            return;
        }
        if (found.where === 'local') {
            await drawHere(ctx, found.name, found.kept);
            return;
        }
        const connect = publishedConnect();
        if (connect === null) {
            // /remote is what carries the connect, and it is part of rho, so
            // this is a session started with extensions turned off rather than
            // a state to recover from.
            ctx.ui.notify(
                `${name} is on ${found.host}, and the /remote extension that connects to it is not loaded here.`,
                'error',
            );
            return;
        }
        await connect(ctx, found.name, found.host);
    };

    pi.registerCommand('attach', {
        description: 'come back to a session left running, here or on another machine: /attach <name>',
        getArgumentCompletions: (text) =>
            completeLastWord(
                text,
                offers().map((offer) => ({ value: offer.name, description: offer.detail })),
            ),
        handler: async (args: string, ctx: ExtensionContext) => {
            const name = args.trim();
            if (name === '') {
                const known = offers();
                ctx.ui.notify(
                    known.length === 0
                        ? 'Nothing has been left running. /detach leaves this session running here.'
                        : known.map((offer) => `${offer.name} (${offer.detail})`).join(', '),
                    'info',
                );
                return;
            }
            await attachTo(ctx, name);
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
