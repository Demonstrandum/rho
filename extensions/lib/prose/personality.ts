// where a personality comes from, how it is named, and what text it puts in
// front of the model. the extension (extensions/personality.ts) owns when to
// inject; this module owns resolution and rendering, so both are testable
// without a session.
//
// three sources, searched in this order for a bare name:
//   user      <rho config dir>/personalities/<name>.md
//   bundled   <package>/personalities/<name>.md
// a user file shadows a bundled one of the same name, which is how a shipped
// prototype is edited without forking the package.
//
// a path argument (anything holding a separator, a leading ~ or ., or a .md
// suffix) is taken as a path and never looked up by name, so a file called
// `laconic.md` in the working directory cannot be silently replaced by the
// bundled `laconic`.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { rhoRoot } from '../core/rho-root';
import { fileURLToPath } from 'node:url';
import envPaths from 'env-paths';

/** which of the three directories (or neither) a personality was read from. */
export type PersonalityOrigin = 'bundled' | 'user' | 'project' | 'file';

/** a personality that has been found but not necessarily read. */
export interface PersonalityRef {
    readonly name: string;
    readonly origin: PersonalityOrigin;
    readonly path: string;
}

/** a personality with its text, which is the only form that can be injected. */
export interface Personality extends PersonalityRef {
    readonly text: string;
}

/**
 * how the personality reached the model. `prompt` means it is appended to the
 * system prompt on every turn; `message` means one custom message was recorded
 * in the conversation and nothing is appended.
 */
export type InjectionMode = 'prompt' | 'message';

// found rather than counted: the remote agent package has these files at a
// different depth, and a count lands outside it. see rho-root.ts.
const packageDir = rhoRoot(fileURLToPath(import.meta.url));
const paths = envPaths('rho', { suffix: '' });

export const BUNDLED_DIR = join(packageDir, 'personalities');
export const USER_DIR = join(paths.config, 'personalities');

function listDir(dir: string, origin: PersonalityOrigin): PersonalityRef[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((file) => file.endsWith('.md'))
        .map((file) => ({ name: basename(file, '.md'), origin, path: join(dir, file) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** every named personality, user files shadowing bundled ones. */
export function catalogue(): PersonalityRef[] {
    const byName = new Map<string, PersonalityRef>();
    for (const ref of listDir(BUNDLED_DIR, 'bundled')) byName.set(ref.name, ref);
    for (const ref of listDir(USER_DIR, 'user')) byName.set(ref.name, ref);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * the outcome of resolving one argument. a failure names what was looked for
 * rather than returning null, so the command can say which of the three ways
 * of being wrong happened.
 */
export type Resolution =
    | { readonly kind: 'ok'; readonly personality: Personality }
    | { readonly kind: 'unknown'; readonly name: string; readonly known: readonly string[] }
    | { readonly kind: 'missing'; readonly path: string }
    | { readonly kind: 'unreadable'; readonly path: string; readonly message: string };

function looksLikePath(arg: string): boolean {
    return arg.includes('/') || arg.startsWith('~') || arg.startsWith('.') || arg.endsWith('.md');
}

export function expandPath(arg: string, cwd: string): string {
    if (arg === '~') return homedir();
    if (arg.startsWith('~/')) return join(homedir(), arg.slice(2));
    return isAbsolute(arg) ? arg : resolve(cwd, arg);
}

/** read a file into a Personality, reporting the two ways reading can fail. */
export function read(path: string, origin: PersonalityOrigin, name?: string): Resolution {
    if (!existsSync(path)) return { kind: 'missing', path };
    try {
        if (statSync(path).isDirectory()) return { kind: 'missing', path };
        const text = readFileSync(path, 'utf8').trim();
        if (text === '') return { kind: 'unreadable', path, message: 'file is empty' };
        return { kind: 'ok', personality: { name: name ?? basename(path, '.md'), origin, path, text } };
    } catch (error) {
        return { kind: 'unreadable', path, message: error instanceof Error ? error.message : String(error) };
    }
}

/** resolve a `/personality` argument: a path if it looks like one, else a name. */
export function resolveArgument(arg: string, cwd: string): Resolution {
    if (looksLikePath(arg)) return read(expandPath(arg, cwd), 'file');
    const known = catalogue();
    const ref = known.find((candidate) => candidate.name === arg);
    if (ref === undefined) return { kind: 'unknown', name: arg, known: known.map((c) => c.name) };
    return read(ref.path, ref.origin, ref.name);
}

/** the working tree's own personality file, when it has one. */
export function projectPersonality(cwd: string, filename: string): Personality | null {
    const result = read(join(cwd, filename), 'project', basename(filename, '.md'));
    return result.kind === 'ok' ? result.personality : null;
}

// the failure this preamble exists to prevent: the model treats the file as a
// topic and writes about the character in its own register, which reads as a
// narrator doing an impression. the file is a script, not a briefing, and the
// examples in it are the specification the output is measured against.
const PREAMBLE = 'the text below is the voice you speak in from now on.\n'
    + 'it is a script, not a description of someone else, and not a subject you comment on.\n'
    + 'you are not imitating this person and you are not narrating them; this is how you talk in this session.\n'
    + '\n'
    + 'the examples in it are the specification.\n'
    + 'every sentence you write must be one that could sit among them unnoticed: same length, same diction, same rhythm, same amount of punctuation.\n'
    + 'a sentence that explains, qualifies, or balances two things with a colon is almost always the wrong register, whatever words it uses.\n'
    + 'writing a correct sentence and then adding the slang is the failure; the sentence has to be built in the voice from the first word.\n'
    + '\n'
    + 'the voice holds for every sentence, not for the first one.\n'
    + 'the common slide is a strong opening line and then plain standard English for the small print: the last sentence, the aside in brackets, the note about what was left alone.\n'
    + 'a sentence that would pass unnoticed in an ordinary status report is wrong wherever it sits in the reply.\n'
    + '\n'
    + 'counts and rhythm are where a voice dies quietly.\n'
    + 'a count the reader acts on stays exact: how many tests pass, how many commits a push destroys, how many files changed.\n'
    + 'a count that is only scenery is said the way the voice says quantities, so an informal one reaches for "just a file", "a couple of them", "a few", "loads of", "nothing in there" rather than counting to one.\n'
    + 'a one-word verdict the voice owns is the voice: "sorted", "dismissed", "we good", "boring".\n'
    + 'what is not the voice is a whole reply built of short report fragments, each carrying one fact and a full stop, since that is the default terse register and it makes every personality sound the same.\n'
    + 'run the reasoning together the way the voice does, with "and", "but", "so", and commas, and let the short line land at the end of it.\n'
    + '\n'
    + 'this holds everywhere: answers, refusals, questions back, one-word replies, and any answer about the personality itself.\n'
    + 'asked what personality you have, answer in it; do not summarise the file, quote it, or list its rules.\n'
    + '\n'
    + 'a personality carrying a sign-off section suspends the rule against closing lines, and only that rule.\n'
    + 'the sign-off is one line, at the end of finished work with nothing outstanding, never after a failure, a refusal, or a question back, and never twice running.\n'
    + 'the examples in that section set the range; write a new one each time rather than reusing them, and drop the line entirely when nothing fresh comes.\n'
    + '\n'
    + 'a personality carrying an emoji section suspends the rule against emoji, and only that rule.\n'
    + 'the characters listed there are the whole permitted set, at most one in a reply, at the end of a line, and only where it is doing the job a gesture would do.\n'
    + 'none appears in a file, a commit message, a path, a command, a code block, or a quoted error, and none appears in the sentence warning that something cannot be undone.\n'
    + 'a personality with no emoji section uses none at all.\n'
    + '\n'
    + 'the voice governs manner only.\n'
    + 'it never changes what is true, what was run, what a file is called, or what a count is, and it never relaxes any other rule above.\n'
    + 'where the two conflict, the rules above win and the voice yields.';

/** the block appended to the system prompt in `prompt` mode. */
export function block(personality: Personality): string {
    return `<personality name="${personality.name}">\n${PREAMBLE}\n\n${personality.text}\n</personality>`;
}

/** the custom message sent in `message` mode, where the prompt is untouchable. */
export function announcement(personality: Personality): string {
    return `<personality name="${personality.name}">\n${PREAMBLE}\n\n${personality.text}\n</personality>\n`
        + 'this applies from here on, and replaces any personality set earlier in this session.';
}

/** the custom message sent when a personality is dropped mid-session. */
export function revocation(name: string): string {
    return `<personality name="none">\nthe "${name}" personality no longer applies.\n`
        + 'from here on, answer in the default manner set by the rules above.\n</personality>';
}
