// the theme a tool row draws with, as an interface rather than pi's class.
//
// every module under tool-row/ is pure: it takes a theme and returns styled
// strings, so it runs in a test and in the demo with no session. pi's own
// theme object satisfies RowTheme once `highlight` is bound to the standalone
// highlightCode export, which tool-rows.ts does; PLAIN_THEME drops every
// escape, which is what the tests read.

/** the subset of pi's ThemeColor these modules draw with. */
export type RowColor =
    | 'toolTitle' | 'toolOutput' | 'text' | 'muted' | 'dim'
    | 'accent' | 'error' | 'warning' | 'success';

export interface RowTheme {
    fg(color: RowColor, text: string): string;
    bold(text: string): string;
    /** one entry per line of `code`. */
    highlight(code: string, language: string): string[];
}

export const PLAIN_THEME: RowTheme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    highlight: (code) => code.split('\n'),
};
