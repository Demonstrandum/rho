/**
 * What a project and its sessions are called.
 *
 * The repository already has a name and a branch already has a name, so asking
 * for `<project>/<branch>` asked for both again and took the slash as its own
 * punctuation. Branch names contain slashes of their own: `feature/remote` is
 * one branch, not a project called feature.
 */

/** `git@github.com:example-org/demo-server.git` -> `demo-server` */
export function repoName(repo: string): string {
    const tail = repo.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() ?? repo;
    return safe(tail);
}

/** The branch, as something that can be a directory and a session name. */
export function branchSlug(branch: string): string {
    return safe(branch.replace(/\//g, '-'));
}

/** Anything that is not a name is a hyphen: these end up in paths and sockets. */
function safe(word: string): string {
    return word.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * What the first word of a request names.
 *
 * A repository is a URL or a path, so it carries a slash, a colon, or a `.git`
 * suffix. A bare word cannot be cloned, and by the time somebody types one
 * they have usually checked the project out already: it names the directory
 * under ~/projects, and the clone inside it is found rather than made again.
 */
export type ProjectSource =
    | { readonly kind: 'repository'; readonly repo: string }
    | { readonly kind: 'project'; readonly project: string };

export function projectSource(word: string): ProjectSource {
    const clonable = /[/:]/.test(word) || /\.git$/.test(word);
    return clonable ? { kind: 'repository', repo: word } : { kind: 'project', project: safe(word) };
}

/** The directory under ~/projects that a source lives in. */
export function projectNameOf(source: ProjectSource): string {
    return source.kind === 'repository' ? repoName(source.repo) : source.project;
}

/** The source as it should appear in a message to the person who asked. */
export function sourceLabel(source: ProjectSource): string {
    return source.kind === 'repository' ? source.repo : source.project;
}

/** Branches whose session is named after the repository alone. */
const DEFAULT_BRANCHES = ['main', 'master'];

/**
 * What the session for a branch of a repository is called.
 *
 * The repository's name on its own for the default branch, since that is the
 * one people mean, and the branch appended for any other. A name given
 * explicitly wins over both.
 */
export function sessionName(source: ProjectSource, branch: string, given?: string): string {
    if (given !== undefined && given.trim() !== '') return safe(given.trim());
    const project = projectNameOf(source);
    return DEFAULT_BRANCHES.includes(branch) ? project : `${project}-${branchSlug(branch)}`;
}

/** What was asked for, from the words after `/remote project`. */
export interface ProjectRequest {
    readonly source: ProjectSource;
    readonly branch: string;
    /** where the branch starts, when it does not exist yet. */
    readonly base: string | null;
    readonly host: string | null;
    readonly name: string | null;
}

const DEFAULT_BRANCH = 'main';

/**
 * Read `<repo|project> [branch] [from <base>] [user@host] [as <name>]`, in any
 * order after the first word.
 *
 * A host is recognised by its shape rather than its place, because `user@host`
 * cannot be mistaken for a branch, and a person should not have to remember
 * which position it was.
 */
export function parseProjectRequest(words: readonly string[]): ProjectRequest | null {
    const first = words[0];
    if (first === undefined) return null;

    let branch: string | null = null;
    let base: string | null = null;
    let host: string | null = null;
    let name: string | null = null;

    const rest = words.slice(1);
    for (let i = 0; i < rest.length; i++) {
        const word = rest[i] as string;
        if (word === 'as') {
            name = rest[i + 1] ?? null;
            i++;
            continue;
        }
        if (word === 'from') {
            base = rest[i + 1] ?? null;
            i++;
            continue;
        }
        if (host === null && /@/.test(word)) {
            host = word;
            continue;
        }
        if (branch === null) {
            branch = word;
            continue;
        }
    }

    return { source: projectSource(first), branch: branch ?? DEFAULT_BRANCH, base, host, name };
}
