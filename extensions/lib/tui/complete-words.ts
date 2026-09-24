/**
 * Completing the last word of a command's arguments.
 *
 * pi hands a command the whole argument text and replaces the whole of it with
 * whatever value is chosen, so a value holding only the word being typed
 * deletes everything before it: completing the host in
 *
 *   /remote project git@github.com:org/repo.git feature/remote samuel@host
 *
 * left `/remote samuel@host`, which is a different command entirely.
 *
 * So a completion carries the line it belongs to. The label stays the word, to
 * read as a list of choices rather than a list of command lines.
 */

export interface WordChoice {
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
}

export interface Completion {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
}

/** The word being typed, and everything typed before it. */
export function lastWord(text: string): { before: string; word: string } {
    const match = /(^|\s)(\S*)$/.exec(text);
    if (match === null) return { before: '', word: text };
    const word = match[2] ?? '';
    return { before: text.slice(0, text.length - word.length), word };
}

/**
 * The choices that match the word being typed, each as a whole argument line.
 *
 * Returns null when nothing matches, which is what pi reads as "no
 * completions" rather than an empty list.
 */
export function completeLastWord(text: string, choices: readonly WordChoice[]): Completion[] | null {
    const { before, word } = lastWord(text);
    const folded = word.toLowerCase();
    const found = choices.filter((choice) => choice.value.toLowerCase().startsWith(folded));
    if (found.length === 0) return null;
    return found.map((choice) => ({
        value: `${before}${choice.value}`,
        label: choice.label ?? choice.value,
        ...(choice.description === undefined || choice.description === '' ? {} : { description: choice.description }),
    }));
}
