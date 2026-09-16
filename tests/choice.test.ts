import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'bun:test';
import { chooseOne, keyOf, type Option } from '../extensions/lib/choice';

type Way = 'carry' | 'leave' | 'exit';

const WAYS: readonly Option<Way>[] = [
    { id: 'carry', tag: 'carry', label: 'take this conversation back to the local session' },
    { id: 'leave', tag: 'leave', label: 'leave it here, back to the local session as it was' },
    { id: 'exit', tag: 'exit', label: 'leave it here, out to the shell' },
];

interface Drawn {
    render(width: number): string[];
    handleInput(data: string): void;
}

/** The component, and the keys a person sends it. Bold is marked, not styled. */
const harness = () => {
    const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => `*${text}*` };
    const tui = { requestRender: () => {} };
    const held: { component?: Drawn } = {};
    const ctx = {
        ui: {
            custom: (factory: (t: unknown, th: unknown, k: unknown, done: (v: unknown) => void) => unknown) =>
                new Promise((settle) => {
                    held.component = factory(tui, theme, {}, settle) as Drawn;
                }),
        },
    } as unknown as ExtensionContext;
    return {
        ctx,
        press: (key: string) => held.component?.handleInput(key),
        drawn: () => (held.component?.render(80) ?? []).join('\n'),
    };
};

const settled = () => new Promise((wake) => setTimeout(wake, 5));

describe('picking one of a few named outcomes', () => {
    test('the first letter of a tag is the key that picks it', () => {
        expect(WAYS.map((way) => keyOf(way.tag))).toEqual(['c', 'l', 'e']);
    });

    test('a letter answers the question outright', async () => {
        const { ctx, press } = harness();
        const asked = chooseOne(ctx, { title: 'which way out', options: WAYS });
        await settled();
        press('l');
        expect(await asked).toBe('leave');
    });

    test('the arrows and enter still work, from the option named as the start', async () => {
        const { ctx, press } = harness();
        const asked = chooseOne(ctx, { title: 'which way out', options: WAYS, start: 'leave' });
        await settled();
        press('\u001b[B');
        press('\r');
        expect(await asked).toBe('exit');
    });

    test('escape is staying, which no option carries', async () => {
        const { ctx, press } = harness();
        const asked = chooseOne(ctx, { title: 'which way out', options: WAYS });
        await settled();
        press('\u001b');
        expect(await asked).toBeNull();
    });

    test('each row shows its tag with the letter to press picked out', async () => {
        const { ctx, drawn } = harness();
        void chooseOne(ctx, { title: 'which way out', options: WAYS });
        await settled();
        const shown = drawn();
        expect(shown).toContain('[*c*arry]');
        expect(shown).toContain('[*l*eave]');
        expect(shown).toContain('[*e*xit]');
        expect(shown).toContain('take this conversation back to the local session');
    });
});
