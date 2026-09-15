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
        const pi = {
            registerCommand: (name: string, spec: unknown) => {
                commands[name] = spec as { handler: (args: string, ctx: unknown) => Promise<void> };
            },
            registerShortcut: (key: string, spec: unknown) => {
                shortcuts[key] = spec;
            },
        };
        detach(pi as never);
        return { commands, shortcuts };
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
        expect(said[0]).toContain('No session called nothing-by-this-name here');
    });

    test('a session with nothing in it is left, not reported as undetachable', async () => {
        const { commands } = load();
        const said: string[] = [];
        let asked = false;
        const ctx = {
            ui: { notify: (message: string) => said.push(message) },
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
