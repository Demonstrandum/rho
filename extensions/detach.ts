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
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { completeLastWord } from './lib/complete-words';

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

    const detach = async (ctx: ExtensionContext, asked: string | undefined): Promise<void> => {
        if (attached()) {
            (globalThis as { __rho_detaching?: boolean }).__rho_detaching = true;
            ctx.ui.notify('Leaving it running. /attach comes back to it.', 'info');
            ctx.shutdown();
            setTimeout(() => process.exit(0), 1_000);
            return;
        }

        // pi writes the session file as the first turn happens, so a session
        // nobody has spoken to has nothing on disk to hand over. That is not a
        // failure, and saying it as one sends people looking for a fault.
        const file = ctx.sessionManager.getSessionFile();
        if (file === undefined || !existsSync(file)) {
            ctx.ui.notify('Nothing has been said in this session yet, so there is nothing to leave running.', 'info');
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

        ctx.ui.notify(`${name} keeps running here. /attach ${name} comes back to it.`, 'info');
        ctx.shutdown();
        // shutdown is deferred to the next idle moment, and from a key handler
        // that moment did not arrive: the interface stayed up while the daemon
        // waited for it, which is the one state this must not be left in.
        setTimeout(() => process.exit(0), 1_500);
    };

    pi.registerCommand('detach', {
        description: 'leave this session running without an interface: /detach [name]',
        handler: async (args: string, ctx: ExtensionContext) => detach(ctx, args.trim() === '' ? undefined : args.trim()),
    });

    pi.registerCommand('attach', {
        description: 'come back to a session left running here: /attach <name>',
        getArgumentCompletions: (text) => completeLastWord(text, runningHere().map((name) => ({ value: name }))),
        handler: async (args: string, ctx: ExtensionContext) => {
            const name = args.trim();
            const running = runningHere();
            if (name === '') {
                ctx.ui.notify(
                    running.length === 0
                        ? 'Nothing is running here. /detach leaves the current session running.'
                        : `Running here: ${running.join(', ')}`,
                    'info',
                );
                return;
            }
            if (!running.includes(name)) {
                ctx.ui.notify(`No session called ${name} here. Running: ${running.join(', ') || 'none'}`, 'error');
                return;
            }
            // The interface for it is a separate process, as it is for a
            // session on another machine, and this one stands aside for it.
            const client = join(homedir(), 'Code', 'rho', 'bin', 'rho-remote');
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
