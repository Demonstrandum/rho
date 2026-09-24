/**
 * The shortest thing you can type that still means one subcommand.
 *
 * `/remote l` is `list` because nothing else there begins with an l, and
 * `/tape x` is `remix` when nothing else contains an x. Typing the whole word
 * is a tax on a command used all day, and every command that takes a verb was
 * comparing strings by hand, so none of them allowed it.
 *
 * Three stages, in this order, each one only consulted when the one before it
 * found nothing:
 *
 *   1. the whole name, so a name is never reinterpreted as a shortening of
 *      another one: `on` stays `on` even where `online` exists.
 *   2. a prefix, which is what a person means most of the time.
 *   3. a substring, for the letter in the middle that happens to be unique.
 *
 * A stage that matches several names is ambiguous and stops there rather than
 * falling through: `/remote c` should say which two it cannot choose between,
 * not quietly find something by substring instead.
 */

export type Resolution =
    | { readonly kind: 'exact' | 'prefix' | 'substring'; readonly name: string }
    | { readonly kind: 'unknown' }
    | { readonly kind: 'ambiguous'; readonly between: readonly string[] };

/** Case is not part of a verb: `/remote L` is `list`. */
const fold = (word: string): string => word.trim().toLowerCase();

export function resolveShorthand(typed: string, names: readonly string[]): Resolution {
    const word = fold(typed);
    if (word === '') return { kind: 'unknown' };

    const exact = names.find((name) => fold(name) === word);
    if (exact !== undefined) return { kind: 'exact', name: exact };

    const byPrefix = names.filter((name) => fold(name).startsWith(word));
    if (byPrefix.length === 1) return { kind: 'prefix', name: byPrefix[0] as string };
    if (byPrefix.length > 1) return { kind: 'ambiguous', between: byPrefix };

    const bySubstring = names.filter((name) => fold(name).includes(word));
    if (bySubstring.length === 1) return { kind: 'substring', name: bySubstring[0] as string };
    if (bySubstring.length > 1) return { kind: 'ambiguous', between: bySubstring };

    return { kind: 'unknown' };
}

/** The name, or null when it was ambiguous or nothing matched. */
export function shorthandFor(typed: string, names: readonly string[]): string | null {
    const found = resolveShorthand(typed, names);
    return found.kind === 'unknown' || found.kind === 'ambiguous' ? null : found.name;
}

/** What to say when a word did not land on one name. */
export function shorthandComplaint(typed: string, names: readonly string[]): string | null {
    const found = resolveShorthand(typed, names);
    if (found.kind === 'ambiguous') return `${typed.trim()} could be ${found.between.join(' or ')}`;
    if (found.kind === 'unknown') return `no such subcommand: ${typed.trim()}. one of ${names.join(', ')}`;
    return null;
}

/** A command's arguments, with the first word read as one of its verbs. */
export interface Spoken {
    /** The verb in full, whatever was typed, or null when nothing matched one. */
    readonly verb: string | null;
    /** What was typed, kept for a message about a word that matched nothing. */
    readonly typed: string;
    readonly rest: readonly string[];
    /** Why the verb is null, when it is null for a reason worth saying. */
    readonly complaint: string | null;
}

/**
 * Split a command's arguments and resolve the first word.
 *
 * Every command taking a verb was splitting on whitespace and comparing
 * strings, so this is what they do instead. A word that is not a verb comes
 * back as null with the word kept, because in some commands it is a name.
 */
export function takeVerb(args: string, names: readonly string[]): Spoken {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const typed = parts[0] ?? '';
    const rest = parts.slice(1);
    if (typed === '') return { verb: null, typed, rest, complaint: null };
    return { verb: shorthandFor(typed, names), typed, rest, complaint: shorthandComplaint(typed, names) };
}
