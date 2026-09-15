// the block a session opens with: the wordmark, the hint, and what is loaded.
//
// startup.ts puts this at the top of a real session and theme.ts puts it at the
// top of the sample one, so a theme is judged against the screen a session
// actually opens on. one function, so the two cannot draw different headers.
//
// the card is intro-card.ts, which is the animation; this is the text under it.

import type { SlashCommandInfo, Theme } from '@earendil-works/pi-coding-agent';
import type { IntroCard } from './intro-card';

// a short discoverability hint. keep it minimal; the footer carries model and
// token state, so this only points at the two universal entry points.
const HINT = '/ commands \u00b7 ! shell';

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
    const lines = [...intro.render(theme, elapsed), '', theme.fg('dim', HINT)];
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
