import { describe, expect, test } from 'bun:test';
import environment from '../extensions/environment';

/**
 * The completion offered `local` while only `default local` worked, so the
 * command taught a form it then rejected. Whatever the completion suggests has
 * to be something the handler accepts.
 */

interface Spec {
    getArgumentCompletions: (prefix: string) => { value: string }[] | null;
    handler: (args: string, ctx: unknown) => Promise<void>;
}

const command = (): { spec: Spec } => {
    const commands = new Map<string, Spec>();
    const pi = {
        registerTool: () => {},
        registerMessageRenderer: () => {},
        registerCommand: (name: string, spec: Spec) => commands.set(name, spec),
        on: () => {},
        getActiveTools: () => [] as string[],
        setActiveTools: () => {},
        sendMessage: () => {},
    };
    environment(pi as never);
    const spec = commands.get('environment');
    if (spec === undefined) throw new Error('no environment command registered');
    return { spec };
};

const run = async (args: string): Promise<{ text: string; level: string }> => {
    const { spec } = command();
    let text = '';
    let level = '';
    const ctx = {
        ui: {
            notify: (message: string, kind: string) => {
                if (text === '') {
                    text = message;
                    level = kind;
                }
            },
        },
    };
    await spec.handler(args, ctx);
    return { text, level };
};

describe('the environment command', () => {
    test('offers only words it accepts', async () => {
        const { spec } = command();
        const offered = (spec.getArgumentCompletions('') ?? []).map((item) => item.value);
        expect(offered).toContain('local');
        for (const word of offered) {
            const { text } = await run(word);
            // Nothing offered may answer with the usage line, which is what
            // "that is not a thing" looks like here.
            expect(text).not.toContain('is not an environment or a host');
        }
    });

    test('local comes back to this machine', async () => {
        expect((await run('local')).text).toBe('Working locally.');
    });

    test('an unknown name says what is attached rather than a usage line alone', async () => {
        const { text, level } = await run('nonsense');
        expect(level).toBe('error');
        expect(text).toContain('nonsense');
        expect(text).toContain('nothing attached');
    });

    test('drop with nothing to drop says so', async () => {
        expect((await run('drop')).level).toBe('error');
    });

    test('list with nothing attached says so', async () => {
        expect((await run('list')).text).toBe('Nothing attached.');
    });

    test('connect without a target asks for one', async () => {
        expect((await run('connect')).text).toContain('user@host');
    });
});
