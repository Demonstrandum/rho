// a syntax palette: the colours code is drawn in, chosen apart from the theme.
//
// pi keeps one theme, and the nine syntax colours are keys inside it, so the
// colours code is highlighted in are fixed by the theme that draws the borders
// and the footer. a palette here is the code colours alone, laid over whatever
// theme is in force: the session keeps its chrome and takes catppuccin,
// gruvbox, or its own theme's colours for code.
//
// a palette is laid over a theme rather than merged into its json, because a
// theme is not always a file: a built-in has no path to read, and pi hands out
// a Theme object with the colours already encoded as ansi. so `restyle` makes
// an object that delegates to the theme for every colour except the ones the
// palette names. pi asks a Theme for colours two ways, and both are overridden:
// `fg`/`style`/`getFgAnsi` read the precomputed escapes in `this.fgAnsi`, and
// `theme.colors` resolves `this.concreteColors` against the terminal's reported
// defaults, caching that in `this.resolvedColors`, which the new object must
// start without or it inherits the colours it exists to replace. a key pi adds
// later still resolves through the theme it came from.
//
// a colour is parsed by pi's own `parseColor`, so a palette entry may be `#rgb`,
// `#rrggbb`, an index, `oklch()` or `okhsl()`: the set a theme file takes.
//
// the returned object is `instanceof Theme` and keeps the theme's name, so
// pi's own theme list, the settings writer, and rho's picker all read it as the
// theme it is layered on.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { foregroundAnsi, parseColor, type Color, type TerminalColorMode } from '@earendil-works/pi-tui';

/** the roles a palette can set, named as a reader names them. */
export const SYNTAX_ROLES = [
    'comment',
    'keyword',
    'function',
    'variable',
    'string',
    'number',
    'type',
    'operator',
    'punctuation',
    'code',
    'codeBlock',
] as const;

export type SyntaxRole = (typeof SYNTAX_ROLES)[number];

/** which theme colour each role is. */
const THEME_KEY: Readonly<Record<SyntaxRole, ThemeColor>> = {
    comment: 'syntaxComment',
    keyword: 'syntaxKeyword',
    function: 'syntaxFunction',
    variable: 'syntaxVariable',
    string: 'syntaxString',
    number: 'syntaxNumber',
    type: 'syntaxType',
    operator: 'syntaxOperator',
    punctuation: 'syntaxPunctuation',
    code: 'mdCode',
    codeBlock: 'mdCodeBlock',
};

/**
 * what a theme accepts as a colour: `#rgb`, `#rrggbb`, `oklch()`, `okhsl()`, an
 * index into the terminal's 256 colours, or the empty string for the
 * terminal's own foreground.
 */
export type ColorValue = string | number;

export interface SyntaxPalette {
    readonly name: string;
    /** where the colours come from, shown beside the name in the list. */
    readonly origin: string;
    readonly colors: Readonly<Partial<Record<SyntaxRole, ColorValue>>>;
}

// ---------------------------------------------------------------------------
// colour encoding
// ---------------------------------------------------------------------------

export type ColorMode = TerminalColorMode;

/**
 * the colour a palette entry names, or null when it names none. pi's parser
 * throws on anything it does not recognise, and an index outside 0-255 is not
 * a colour a terminal has, so both are refused rather than guessed at.
 */
function parse(color: ColorValue): Color | null {
    if (typeof color === 'number' && (!Number.isInteger(color) || color < 0 || color > 255)) return null;
    try {
        return parseColor(color);
    } catch {
        return null;
    }
}

/**
 * the escape that sets a foreground colour, in the mode the theme was built
 * for. a terminal without truecolour gets the nearest colour it has, which is
 * pi's own approximation rather than a second one written here.
 */
export function fgAnsi(color: ColorValue, mode: ColorMode): string | null {
    if (color === '') return '\x1b[39m';
    const parsed = parse(color);
    return parsed === null ? null : foregroundAnsi(parsed, mode);
}

// ---------------------------------------------------------------------------
// laying a palette over a theme
// ---------------------------------------------------------------------------

/** the theme a restyled theme was made from, so palettes never stack. */
const LAID_OVER = Symbol('rho.syntaxPalette.base');

/** where pi keeps the theme in force; `ctx.ui.theme` is a proxy onto it. */
const LIVE_THEME = Symbol.for('@earendil-works/pi-coding-agent:theme');

/**
 * the Theme object behind whatever `theme` is.
 *
 * `ctx.ui.theme` is a Proxy that forwards every read to the theme in force, so
 * it answers colours correctly and is not a `Theme`: `Object.create` of it
 * inherits the colours and fails `instanceof`, and `ui.setTheme` reads anything
 * that is not a `Theme` as a theme name. so a palette is laid over the instance
 * the proxy stands for, which pi keeps under a well-known global symbol.
 */
function instance(theme: Theme): Theme {
    if (theme instanceof Theme) return theme;
    const live = (globalThis as Record<symbol, unknown>)[LIVE_THEME];
    return live instanceof Theme ? live : theme;
}

interface Restyled {
    [LAID_OVER]: Theme;
    /** the escapes `fg`, `style` and `getFgAnsi` answer from. */
    fgAnsi: Map<string, string>;
    /** the colours `theme.colors` resolves against the terminal's defaults. */
    concreteColors: Record<string, Color>;
}

/** the escape map a Theme resolves `fg` through. private to pi, present here. */
function ansiMap(theme: Theme): Map<string, string> | null {
    const map = (theme as unknown as Partial<Restyled>).fgAnsi;
    return map instanceof Map ? map : null;
}

/** the same theme's concrete colours, which `theme.colors` is built from. */
function concreteColors(theme: Theme): Record<string, Color> {
    const colors = (theme as unknown as Partial<Restyled>).concreteColors;
    return typeof colors === 'object' && colors !== null ? colors : {};
}

/** the theme under any palette, or the theme itself. */
export function themeUnder(theme: Theme): Theme {
    const live = instance(theme);
    return (live as unknown as Partial<Restyled>)[LAID_OVER] ?? live;
}

/**
 * `theme` with the palette's colours in place of its own.
 *
 * returns the theme unchanged when the palette sets nothing usable, so a
 * malformed entry costs the colours it names and nothing else.
 */
export function restyle(theme: Theme, palette: SyntaxPalette): Theme {
    const base = themeUnder(instance(theme));
    const escapes = ansiMap(base);
    if (escapes === null) return base;

    const mode = base.getColorMode();
    const replacedAnsi = new Map(escapes);
    const replacedColors = { ...concreteColors(base) };
    let any = false;
    for (const role of SYNTAX_ROLES) {
        const value = palette.colors[role];
        if (value === undefined) continue;
        const key = THEME_KEY[role];
        if (value === '') {
            // the terminal's own foreground: an escape, and no concrete colour
            // of its own, which is how pi holds a token set to "".
            replacedAnsi.set(key, '\x1b[39m');
            delete replacedColors[key];
            any = true;
            continue;
        }
        const color = parse(value);
        if (color === null) continue;
        replacedAnsi.set(key, foregroundAnsi(color, mode));
        replacedColors[key] = color;
        any = true;
    }
    if (!any) return base;

    const styled = Object.create(base) as Theme;
    Object.defineProperty(styled, 'fgAnsi', { value: replacedAnsi });
    Object.defineProperty(styled, 'concreteColors', { value: replacedColors });
    // pi caches `theme.colors` per instance; an inherited cache would answer
    // with the colours this object exists to replace.
    Object.defineProperty(styled, 'resolvedColors', { value: undefined, writable: true });
    Object.defineProperty(styled, LAID_OVER, { value: base });
    return styled;
}

// ---------------------------------------------------------------------------
// the palettes on disk
// ---------------------------------------------------------------------------

const PALETTES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'syntax.json');

function isColorValue(value: unknown): value is ColorValue {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 255;
    if (typeof value !== 'string') return false;
    return value === '' || parse(value) !== null;
}

function parsePalette(raw: unknown): SyntaxPalette | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== 'string' || entry.name === '') return null;
    if (typeof entry.colors !== 'object' || entry.colors === null) return null;
    const source = entry.colors as Record<string, unknown>;
    const colors: Partial<Record<SyntaxRole, ColorValue>> = {};
    for (const role of SYNTAX_ROLES) {
        const value = source[role];
        if (isColorValue(value)) colors[role] = value;
    }
    if (Object.keys(colors).length === 0) return null;
    return { name: entry.name, origin: typeof entry.origin === 'string' ? entry.origin : '', colors };
}

let loaded: readonly SyntaxPalette[] | null = null;

/** every palette that parses, in the order the file lists them. */
export function palettes(): readonly SyntaxPalette[] {
    if (loaded !== null) return loaded;
    try {
        const file = JSON.parse(readFileSync(PALETTES_PATH, 'utf8')) as { palettes?: unknown };
        const list = Array.isArray(file.palettes) ? file.palettes : [];
        loaded = list.map(parsePalette).filter((entry): entry is SyntaxPalette => entry !== null);
    } catch {
        loaded = [];
    }
    return loaded;
}

export function paletteNamed(name: string): SyntaxPalette | undefined {
    return palettes().find((entry) => entry.name === name);
}

// ---------------------------------------------------------------------------
// the session's choice
// ---------------------------------------------------------------------------

// held here rather than in the extension, so that the theme extension can put
// the palette back over a theme it has just changed without importing it.
let chosen: SyntaxPalette | null = null;

export function chosenPalette(): SyntaxPalette | null {
    return chosen;
}

export function choosePalette(palette: SyntaxPalette | null): void {
    chosen = palette;
}

/** `theme` wearing the session's palette, or bare when none is chosen. */
export function withChosenPalette(theme: Theme): Theme {
    return chosen === null ? themeUnder(theme) : restyle(theme, chosen);
}
