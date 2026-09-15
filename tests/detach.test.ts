import { describe, expect, test } from 'bun:test';
import detach, { nameFor, suggestedName } from '../extensions/detach';

describe('naming a session that is left running', () => {
    test('a name typed by hand is kept as typed', () => {
        expect(nameFor('overnight', 'fallback')).toBe('overnight');
    });

    test('spaces and slashes become something a socket file can be called', () => {
        expect(nameFor('the big one', 'fallback')).toBe('the-big-one');
        expect(nameFor('feature/remote', 'fallback')).toBe('feature-remote');
    });

    test('a name of nothing but punctuation falls back rather than making an empty file', () => {
        expect(nameFor('///', 'fallback')).toBe('fallback');
        expect(nameFor('   ', 'fallback')).toBe('fallback');
        expect(nameFor(undefined, 'fallback')).toBe('fallback');
    });

    test('the suggestion is the directory and the time, so two in a day differ', () => {
        const morning = suggestedName('/Users/samuel/Code/rho', new Date(2026, 0, 1, 9, 5));
        const evening = suggestedName('/Users/samuel/Code/rho', new Date(2026, 0, 1, 21, 40));
        expect(morning).toBe('rho-0905');
        expect(evening).toBe('rho-2140');
    });

    test('a suggestion for the root directory still has a name', () => {
        expect(suggestedName('/', new Date(2026, 0, 1, 0, 0))).toBe('session-0000');
    });
});

describe('the commands it registers', () => {
    const load = () => {
        const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
        const shortcuts: Record<string, unknown> = {};
        const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
        const pi = {
            registerCommand: (name: string, spec: unknown) => {
                commands[name] = spec as { handler: (args: string, ctx: unknown) => Promise<void> };
            },
            registerShortcut: (key: string, spec: unknown) => {
                shortcuts[key] = spec;
            },
            registerFlag: () => {},
            getFlag: () => undefined,
            on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
                handlers[event] = handler;
            },
        };
        detach(pi as never);
        return { commands, shortcuts, handlers };
    };

    test('detach, attach and restart are offered, and ctrl+d is bound', () => {
        const { commands, shortcuts } = load();
        expect(Object.keys(commands).sort()).toEqual(['attach', 'detach', 'restart']);
        expect(Object.keys(shortcuts)).toEqual(['ctrl+d']);
    });

    test('attaching to a name nothing is holding says so, and says what is held', async () => {
        const { commands } = load();
        const said: string[] = [];
        const ctx = { ui: { notify: (message: string) => said.push(message) } };
        await commands.attach!.handler('nothing-by-this-name', ctx);
        expect(said[0]).toContain('No session called nothing-by-this-name');
    });

    test('a turn in flight is not handed over behind the reader s back', async () => {
        // The model call and any command it started belong to this process:
        // the daemon resumes the transcript and does not continue them, so a
        // silent handover left the tool call in the transcript with no output
        // under it and nothing running.
        const { commands } = load();
        const asked: string[] = [];
        let aborted = false;
        let left = false;
        const ctx = {
            ui: {
                notify: () => {},
                select: async (title: string, options: string[]) => {
                    asked.push(title);
                    // Staying: the turn goes on and this interface stays with it.
                    return options[2];
                },
            },
            isIdle: () => false,
            abort: () => {
                aborted = true;
            },
            sessionManager: {
                getSessionFile: () => import.meta.path,
                getCwd: () => '/tmp',
                getSessionId: () => '01a0-test',
            },
            shutdown: () => {
                left = true;
            },
        };
        await commands.detach!.handler('overnight', ctx);
        expect(asked[0]).toContain('A turn is running');
        expect(asked[0]).toContain('cannot be carried over');
        // Declined: the turn goes on and this interface stays with it.
        expect(aborted).toBe(false);
        expect(left).toBe(false);
    });

    test('a turn left to finish hands over when it has, and not before', async () => {
        // The turn cannot move, and killing it throws away whatever it was
        // doing: a command streaming its output loses the rest of that output
        // and the transcript keeps a tool call with nothing under it. Waiting
        // costs nothing and leaves the whole turn to reattach to.
        const { commands, handlers } = load();
        const said: string[] = [];
        let idle = false;
        let left = false;
        const ctx = {
            ui: {
                notify: (message: string) => said.push(message),
                select: async (_title: string, options: string[]) => options[0],
                input: async () => 'overnight',
            },
            isIdle: () => idle,
            abort: () => {},
            sessionManager: {
                getSessionFile: () => undefined,
                getCwd: () => '/tmp',
                getSessionId: () => '01a0-test',
            },
            shutdown: () => {
                left = true;
            },
        };
        await commands.detach!.handler('overnight', ctx);
        expect(said[0]).toContain('when this turn finishes');
        expect(left).toBe(false);

        // The turn ends, and the handover runs itself. This session has no
        // file, so leaving is all there is to do, which is what shutdown is.
        idle = true;
        await handlers.agent_settled?.({}, ctx);
        expect(left).toBe(true);
    });

    test('talking to the session again cancels a detach that was waiting', async () => {
        const { commands, handlers } = load();
        let left = false;
        const ctx = {
            ui: {
                notify: () => {},
                select: async (_title: string, options: string[]) => options[0],
            },
            isIdle: () => false,
            abort: () => {},
            sessionManager: {
                getSessionFile: () => undefined,
                getCwd: () => '/tmp',
                getSessionId: () => '01a0-test',
            },
            shutdown: () => {
                left = true;
            },
        };
        await commands.detach!.handler('overnight', ctx);
        await handlers.input?.({}, ctx);
        await handlers.agent_settled?.({}, ctx);
        expect(left).toBe(false);
    });

    test('a session with nothing in it is left, not reported as undetachable', async () => {
        const { commands } = load();
        const said: string[] = [];
        let asked = false;
        const ctx = {
            ui: { notify: (message: string) => said.push(message) },
            isIdle: () => true,
            sessionManager: {
                getSessionFile: () => undefined,
                getCwd: () => '/tmp',
                getSessionId: () => '01a0-test',
            },
            shutdown: () => {
                asked = true;
            },
        };
        await commands.detach!.handler('', ctx);
        // ctrl+d in an empty session means what it means in any terminal.
        expect(asked).toBe(true);
        expect(said).toEqual([]);
    });
});
