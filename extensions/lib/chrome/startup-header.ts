// the block a session opens with: the wordmark, the hint, and what is loaded.
//
// startup.ts puts this at the top of a real session and theme.ts puts it at the
// top of the sample one, so a theme is judged against the screen a session
// actually opens on. one function, so the two cannot draw different headers.
//
// the card is intro-card.ts, which is the animation; this is the text under it.

import { keyText, type SlashCommandInfo, type Theme } from '@earendil-works/pi-coding-agent';
import type { IntroCard } from './intro-card';
import { DETACH_KEY } from '../remote/leaving';

// pi's compact startup hint (`compactInstructions` in interactive-mode.js),
// with `! bash` read as `! shell`. keys come from the live keybindings, and the
// colours from the theme passed in rather than pi's global one, so theme.ts can
// draw the header in a theme it is only previewing.
//
// an action with no key bound is left out: rho unbinds app.exit (detach.ts
// takes ctrl+d), and pi's own line would then read `ctrl+c/ clear/exit`.
// detach gets a segment of its own, shown while its command is loaded.
type Keybinding = Parameters<typeof keyText>[0];

/** a configurable binding, or a key pi fixes (the `/` and `!` prefixes). */
type HintKey = { readonly binding: Keybinding } | { readonly literal: string };

interface HintAction {
    readonly key: HintKey;
    readonly description: string;
    /** an extension command that must be loaded for the key to do this. */
    readonly command?: string;
}

/** one segment of the line; actions in one segment share it as `a/b desc/desc`. */
type HintPart = readonly HintAction[];

const HINT_PARTS: readonly HintPart[] = [
    [{ key: { binding: 'app.interrupt' }, description: "interrupt" }],
    [
        { key: { binding: 'app.clear' }, description: "clear" },
        { key: { binding: 'app.exit' }, description: "exit" },
    ],
    [{ key: { literal: DETACH_KEY }, description: "detach", command: 'detach' }],
    [{ key: { literal: '/' }, description: "commands" }],
    [{ key: { literal: '!' }, description: "shell" }],
    [{ key: { binding: 'app.tools.expand' }, description: "more" }],
];

const keysOf = (key: HintKey): string => ('binding' in key ? keyText(key.binding) : key.literal);

function hintLine(theme: Theme, commands: readonly SlashCommandInfo[]): string {
    const loaded = (name: string) =>
        commands.some((command) => command.source === 'extension' && command.name === name);
    const segments = HINT_PARTS.flatMap((part) => {
        const bound = part
            .filter((action) => action.command === undefined || loaded(action.command))
            .map((action) => ({ keys: keysOf(action.key), description: action.description }))
            .filter((action) => action.keys !== '');
        if (bound.length === 0) return [];
        const keys = bound.map((action) => action.keys).join('/');
        const descriptions = bound.map((action) => action.description).join('/');
        return [theme.fg('dim', keys) + theme.fg('muted', ` ${descriptions}`)];
    });
    return segments.join(theme.fg('muted', " \u00b7 "));
}

interface Section {
    readonly label: string;
    readonly items: readonly string[];
    /** for the themes section: the active theme, which renders bold. */
    readonly current?: string;
}

/**
 * subcommands collapse into the command they belong to: `/btw:clear` and
 * `/btw:inject` are listed as `/btw`, once.
 *
 * the suffix is only dropped when the bare name is itself a command from the
 * same source, so a namespaced name with no parent (`context-mode:ctx-search`)
 * is left whole rather than turned into a command that does not exist.
 */
export function sortedNames(
    commands: readonly SlashCommandInfo[],
    source: SlashCommandInfo['source'],
    prefix: string,
): string[] {
    const names = commands.filter((command) => command.source === source).map((command) => command.name);
    const parents = new Set(names);
    const listed = new Set(
        names.map((name) => {
            const colon = name.indexOf(':');
            const base = colon === -1 ? name : name.slice(0, colon);
            return parents.has(base) ? base : name;
        }),
    );
    return [...listed].map((name) => `${prefix}${name}`).sort((a, b) => a.localeCompare(b));
}

export interface HeaderOptions {
    intro: IntroCard;
    theme: Theme;
    /** milliseconds since the card started playing. */
    elapsed: number;
    commands: readonly SlashCommandInfo[];
    /** the loaded theme names, active one included. */
    themes: readonly string[];
    /**
     * this session's id, printed under the header.
     *
     * a session that crashes takes /session with it, and the transcript is
     * addressed by id: without it on screen from the start, the record of what
     * just went wrong has to be found by timestamp.
     */
    sessionId?: string;
}

export function headerLines(options: HeaderOptions): string[] {
    const { intro, theme, elapsed, commands, themes, sessionId } = options;
    const sections: Section[] = [
        { label: 'prompts', items: sortedNames(commands, 'prompt', '/') },
        { label: 'skills', items: sortedNames(commands, 'skill', '') },
        { label: 'commands', items: sortedNames(commands, 'extension', '/') },
        { label: 'themes', items: [...themes].sort((a, b) => a.localeCompare(b)), current: theme.name },
        ...(sessionId === undefined ? [] : [{ label: 'session', items: [sessionId] }]),
    ].filter((section) => section.items.length > 0);

    const labelWidth = sections.reduce((max, section) => Math.max(max, section.label.length), 0);
    const lines = [...intro.render(theme, elapsed), '', hintLine(theme, commands)];
    for (const section of sections) {
        const label = theme.bold(theme.fg('accent', section.label.padEnd(labelWidth)));
        if (section.current !== undefined && section.items.includes(section.current)) {
            // the active theme takes the same dim colour as the rest, and bold.
            const parts = section.items.map((name) =>
                name === section.current ? theme.bold(theme.fg('dim', name)) : theme.fg('dim', name),
            );
            lines.push(`${label}  ${parts.join(theme.fg('dim', ', '))}`);
        } else {
            lines.push(`${label}  ${theme.fg('dim', section.items.join(', '))}`);
        }
    }
    return lines;
}
