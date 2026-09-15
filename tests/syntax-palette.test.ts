import { test, expect } from 'bun:test';
import {
    SYNTAX_ROLES,
    chosenPalette,
    choosePalette,
    fgAnsi,
    paletteNamed,
    palettes,
    restyle,
    themeUnder,
    withChosenPalette,
    type SyntaxPalette,
} from '../extensions/lib/syntax-palette';
import { Theme } from '@earendil-works/pi-coding-agent';

/**
 * a stand-in for pi's Theme: the two things a palette touches are the map `fg`
 * resolves through and the colour mode. anything else a Theme has is inherited
 * from this object the same way it is from a real one.
 */
function fakeTheme(name: string, colors: Record<string, string>): Theme {
    const theme = {
        name,
        fgColors: new Map(Object.entries(colors)),
        getColorMode: () => 'truecolor' as const,
        getFgAnsi(color: string): string {
            const ansi = (this as unknown as { fgColors: Map<string, string> }).fgColors.get(color);
            if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
            return ansi;
        },
    };
    return theme as unknown as Theme;
}

const base = (): Theme =>
    fakeTheme('plan9-dark', {
        border: '\x1b[38;2;147;144;106m',
        syntaxKeyword: '\x1b[38;2;132;148;204m',
        syntaxString: '\x1b[38;2;113;168;127m',
        mdCode: '\x1b[38;2;113;168;127m',
    });

test('every shipped palette parses and names known roles', () => {
    const all = palettes();
    expect(all.length).toBeGreaterThan(5);
    for (const palette of all) {
        expect(palette.name).not.toBe('');
        for (const role of Object.keys(palette.colors)) {
            expect(SYNTAX_ROLES).toContain(role as (typeof SYNTAX_ROLES)[number]);
        }
    }
});

test('a hex colour becomes a truecolour escape, an index a 256 one', () => {
    expect(fgAnsi('#FF79C6', 'truecolor')).toBe('\x1b[38;2;255;121;198m');
    expect(fgAnsi(5, 'truecolor')).toBe('\x1b[38;5;5m');
    expect(fgAnsi('', 'truecolor')).toBe('\x1b[39m');
});

test('a hex colour falls to the nearest cube colour without truecolour', () => {
    expect(fgAnsi('#000000', '256color')).toBe('\x1b[38;5;16m');
    expect(fgAnsi('#FFFFFF', '256color')).toBe('\x1b[38;5;231m');
});

test('an unusable colour is refused rather than guessed at', () => {
    expect(fgAnsi('#GGGGGG', 'truecolor')).toBeNull();
    expect(fgAnsi(300, 'truecolor')).toBeNull();
});

test('a palette replaces the colours it names and no others', () => {
    const theme = base();
    const styled = restyle(theme, paletteNamed('dracula')!);
    expect(styled.getFgAnsi('syntaxKeyword')).toBe('\x1b[38;2;255;121;198m');
    expect(styled.getFgAnsi('border')).toBe(theme.getFgAnsi('border'));
    expect(theme.getFgAnsi('syntaxKeyword')).toBe('\x1b[38;2;132;148;204m');
});

test('the theme keeps its name under a palette', () => {
    expect(restyle(base(), paletteNamed('nord')!).name).toBe('plan9-dark');
});

test('palettes do not stack: a second one lies over the same theme', () => {
    const theme = base();
    const once = restyle(theme, paletteNamed('nord')!);
    const twice = restyle(once, paletteNamed('monokai')!);
    expect(themeUnder(twice)).toBe(theme);
    expect(twice.getFgAnsi('syntaxKeyword')).toBe(restyle(theme, paletteNamed('monokai')!).getFgAnsi('syntaxKeyword'));
});

test('a palette that names nothing usable leaves the theme alone', () => {
    const theme = base();
    const empty: SyntaxPalette = { name: 'broken', origin: '', colors: { keyword: '#ZZZZZZ' } };
    expect(restyle(theme, empty)).toBe(theme);
});

/**
 * `ctx.ui.theme` is not a Theme: it is a proxy that forwards every read to the
 * theme in force, kept by pi under this symbol. a palette laid over the proxy
 * rather than over the instance fails `instanceof Theme`, and `ui.setTheme`
 * reads anything that is not a Theme as a theme name, so nothing is applied.
 */
test('a palette laid over pi ui proxy reaches the theme behind it', () => {
    // the four the constructor reads to fill in its optional colours, plus the
    // two this test compares.
    const colors = {
        muted: '#777777',
        text: '',
        thinkingXhigh: '#888888',
        syntaxKeyword: '#112233',
        border: '#445566',
    };
    const real = new Theme(colors as never, { selectedBg: '#222222' } as never, 'truecolor', { name: 'live' });
    const key = Symbol.for('@earendil-works/pi-coding-agent:theme');
    const before = (globalThis as Record<symbol, unknown>)[key];
    (globalThis as Record<symbol, unknown>)[key] = real;
    try {
        const proxy = new Proxy(
            {},
            { get: (_target, prop) => (real as unknown as Record<string | symbol, unknown>)[prop] },
        ) as Theme;
        expect(proxy instanceof Theme).toBe(false);

        const styled = restyle(proxy, paletteNamed('dracula')!);
        expect(styled instanceof Theme).toBe(true);
        expect(styled.getFgAnsi('syntaxKeyword')).toBe('\x1b[38;2;255;121;198m');
        expect(styled.getFgAnsi('border')).toBe(real.getFgAnsi('border'));
        expect(themeUnder(styled)).toBe(real);
    } finally {
        (globalThis as Record<symbol, unknown>)[key] = before;
    }
});

test('the session choice is what a theme change puts back on', () => {
    const theme = base();
    choosePalette(null);
    expect(withChosenPalette(theme)).toBe(theme);

    choosePalette(paletteNamed('gruvbox-dark')!);
    expect(chosenPalette()?.name).toBe('gruvbox-dark');
    expect(withChosenPalette(theme).getFgAnsi('syntaxKeyword')).toBe('\x1b[38;2;251;73;52m');
    choosePalette(null);
});
