// what a slash command takes, and which of its forms the typed text is on its
// way to.
//
// a command has one or more forms, each a line like
//
//   /remote create <name> <user@host>
//   /remote project <repo> [branch] [user@host] [as <name>]
//
// three sources feed the table, in order of preference: a form declared here
// or by an extension through declareUsage, the fragments a command already
// writes into its own description (several of rho's do: "/slack <app>,
// /slack off, /slack add <app>"), and nothing, in which case the command has
// no hint and none is shown.
//
// matching is over tokens rather than the raw string, because the text typed
// so far picks the form: `/remote pro` is on its way to the project line and
// no other, and `/remote` alone is on its way to all of them, so the first
// declared wins. a literal token that matches what was typed is evidence for
// its form; one that contradicts it is evidence against.

/** one word of a form, as the matcher sees it. */
export type UsageToken =
    | { readonly kind: 'literal'; readonly word: string; readonly optional: boolean }
    | { readonly kind: 'value'; readonly label: string; readonly optional: boolean };

export interface UsageForm {
    /** the command this form belongs to, without its slash. */
    readonly command: string;
    /** the line as it is shown, slash included. */
    readonly text: string;
    /** the argument words, after the command name. */
    readonly tokens: readonly UsageToken[];
}

/** what a command is named and what it says about itself. */
export interface KnownCommand {
    readonly name: string;
    readonly description?: string;
}

// forms for the commands whose descriptions do not carry them, or carry less
// than the handler accepts. a command absent from here falls back to its
// description.
const DECLARED: Record<string, readonly string[]> = {
    remote: [
        '/remote connect <name>',
        '/remote create <name> <user@host>',
        '/remote project <repo> [branch] [user@host] [as <name>]',
        '/remote list [user@host]',
        '/remote manage',
        '/remote stop <name>',
    ],
    environment: [
        '/environment <user@host>',
        '/environment local',
        '/environment list',
        '/environment drop <name>',
    ],
    project: ['/project <repo> [branch] [as <name>]'],
    personality: ['/personality <name|path|off>'],
    theme: ['/theme [name]'],
    syntax: ['/syntax [name]'],
    cwd: ['/cwd [path]'],
    goal: ['/goal <condition>'],
    stash: ['/stash [clear|undo]'],
    web: ['/web [port]', '/web stop', '/web restart', '/web status', '/web logs', '/web doctor', '/web open'],
    rho: ['/rho config', '/rho config overwrite', '/rho config write <path>'],
    search: ['/search <words>'],
    detach: ['/detach [name]'],
    attach: ['/attach <name>'],
};

const declared: Map<string, string[]> = new Map(
    Object.entries(DECLARED).map(([name, forms]) => [name, [...forms]]),
);

/** give a command its forms, replacing whatever it had. */
export function declareUsage(command: string, forms: readonly string[]): void {
    declared.set(command, [...forms]);
}

/**
 * a word is a value rather than a literal when it is bracketed (`<name>`),
 * when it holds an address (`user@host`), when it is written in capitals
 * (`PORT`), or when it is the whole of an optional group (`[branch]`), since
 * an optional group naming one thing names what goes there. a bare word
 * standing beside another inside a group is a keyword: the `as` of
 * `[as <name>]`.
 */
function tokenOf(word: string, optional: boolean, alone: boolean): UsageToken {
    const bare = word.replace(/^<|>$/g, '');
    const isValue =
        (word.startsWith('<') && word.endsWith('>')) ||
        bare.includes('@') ||
        (bare.length > 1 && /^[A-Z][A-Z_]*$/.test(bare)) ||
        (optional && alone);
    return isValue
        ? { kind: 'value', label: bare, optional }
        : { kind: 'literal', word: bare, optional };
}

/** read one form line. the command name is stripped; the rest becomes tokens. */
export function parseForm(command: string, line: string): UsageForm {
    const text = line.trim();
    const words = text.split(/\s+/);
    const head = words[0] ?? '';
    const args = head === `/${command}` || head === command ? words.slice(1) : words;

    // a group is read whole, because whether its words are keywords depends on
    // how many of them there are.
    const tokens: UsageToken[] = [];
    let group: string[] = [];
    let depth = 0;
    const flush = (optional: boolean): void => {
        for (const word of group) {
            tokens.push(tokenOf(word, optional, group.length === 1));
        }
        group = [];
    };

    for (const word of args) {
        const opens = word.startsWith('[');
        const closes = word.endsWith(']');
        const bare = word.replace(/^\[+/, '').replace(/\]+$/, '');
        if (opens) {
            flush(depth > 0);
            depth++;
        }
        if (bare !== '') group.push(bare);
        if (closes) {
            flush(true);
            depth = Math.max(0, depth - 1);
        }
    }
    flush(depth > 0);

    return { command, text: text.startsWith('/') ? text : `/${command} ${text}`.trimEnd(), tokens };
}

/**
 * the usage fragments a description writes for itself, in the order given. a
 * fragment runs from the slash to the next comma, semicolon, or line end, so
 * the prose a description opens with is dropped and the forms behind it stay.
 */
export function formsFromDescription(command: string, description: string): string[] {
    const out: string[] = [];
    for (const part of description.split(/[,;\n]/)) {
        const at = part.indexOf(`/${command}`);
        if (at === -1) continue;
        const fragment = part.slice(at).trim().replace(/[.]$/, '');
        const next = fragment.slice(command.length + 1, command.length + 2);
        if (next === '' || next === ' ') out.push(fragment);
    }
    return out;
}

export function formsFor(command: KnownCommand): UsageForm[] {
    const lines = declared.get(command.name) ?? formsFromDescription(command.name, command.description ?? '');
    return lines.map((line) => parseForm(command.name, line));
}

/** what has been typed, once the leading slash has been read. */
interface Typed {
    readonly name: string;
    /** true while the name is still being typed, so it may be a prefix. */
    readonly naming: boolean;
    readonly words: readonly string[];
    /** the word under the cursor, when it is unfinished. */
    readonly partial: string | null;
}

function readTyped(text: string): Typed | null {
    if (!text.startsWith('/') || text.includes('\n')) return null;
    const match = /^\/(\S*)(\s+)?([\s\S]*)$/.exec(text);
    if (match === null) return null;
    const [, name, gap, rest = ''] = match;
    if (name === '') return null;
    if (gap === undefined) return { name, naming: true, words: [], partial: null };

    const words = rest.split(/\s+/).filter((word) => word !== '');
    const unfinished = rest !== '' && !/\s$/.test(rest);
    return {
        name,
        naming: false,
        words: unfinished ? words.slice(0, -1) : words,
        partial: unfinished ? (words[words.length - 1] ?? null) : null,
    };
}

function resolve(typed: Typed, known: readonly KnownCommand[]): KnownCommand | undefined {
    const exact = known.find((command) => command.name === typed.name);
    if (exact !== undefined || !typed.naming) return exact;
    const prefixed = known.filter((command) => command.name.startsWith(typed.name));
    return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * how far into `form` the completed words reach, or null when the form cannot
 * be what is being typed: a required literal contradicted rules its form out
 * rather than costing it a point. an optional literal that does not match is
 * passed over, since it is allowed to be absent.
 *
 * a word past the last token leaves the form standing. the tokens are one
 * word each and a value is not: `/goal <condition>` takes a sentence, and a
 * form the reader has followed to its end is still the form they are
 * following.
 */
function reached(form: UsageForm, words: readonly string[]): number | null {
    let at = 0;
    for (const word of words) {
        while (at < form.tokens.length) {
            const token = form.tokens[at];
            at++;
            if (token.kind === 'value' || token.word === word) break;
            if (!token.optional) return null;
        }
    }
    return at;
}

/** the token an unfinished word is on its way to, or null when there is none. */
function awaited(form: UsageForm, at: number, partial: string | null): UsageToken | null {
    let i = at;
    while (i < form.tokens.length) {
        const token = form.tokens[i];
        if (partial === null || token.kind === 'value' || token.word.startsWith(partial)) return token;
        if (!token.optional) return null;
        i++;
    }
    return null;
}

function shown(token: UsageToken): string {
    return token.kind === 'value' ? `<${token.label}>` : token.word;
}

/**
 * the forms still open to the typed text, each with the token it is waiting
 * for. a form drops out the moment a word contradicts it, so `/remote conn`
 * leaves one and `/remote c` leaves two.
 */
function candidates(forms: readonly UsageForm[], typed: Typed): { form: UsageForm; next: UsageToken | null }[] {
    const open: { form: UsageForm; next: UsageToken | null }[] = [];
    for (const form of forms) {
        const at = reached(form, typed.words);
        if (at === null) continue;
        const next = awaited(form, at, typed.partial);
        // an unfinished word has to be going somewhere: a form with a token
        // left but none that starts that way is not what is being typed. a
        // form with no token left is, since the word is more of its last
        // value.
        if (typed.partial !== null && next === null && at < form.tokens.length) continue;
        open.push({ form, next });
    }
    return open;
}

/**
 * the line to show beside `text`, or undefined when the text names no command,
 * names an ambiguous one, names one with nothing declared, or has gone past
 * every form the command has.
 *
 * with one form left, the whole of it is shown. with several, the choice
 * between them is: `/remote` offers `[connect|create|project|...]` and
 * `/remote c` narrows that to `[connect|create]`, which is the question the
 * reader is answering, where the first form in the table would be an answer
 * to a question nobody asked.
 */
export function hintFor(text: string, known: readonly KnownCommand[]): string | undefined {
    const typed = readTyped(text);
    if (typed === null) return undefined;

    const command = resolve(typed, known);
    if (command === undefined) return undefined;

    const forms = formsFor(command);
    if (forms.length === 0) return undefined;

    const open = candidates(forms, typed);
    if (open.length === 0) return undefined;
    if (open.length === 1) return open[0].form.text;

    // what the typed words have settled, which the choice is offered after.
    const head = [`/${command.name}`, ...typed.words].join(' ');

    const members: string[] = [];
    for (const { next } of open) {
        if (next === null) continue;
        const word = shown(next);
        if (!members.includes(word)) members.push(word);
    }
    // every open form wants the same thing next, so there is no choice to
    // offer and the first of them stands for all of them.
    if (members.length < 2) return open[0].form.text;

    return `${head} [${members.join('|')}]`;
}
