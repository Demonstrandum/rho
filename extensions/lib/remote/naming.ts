/**
 * What a project and its sessions are called.
 *
 * The repository already has a name and a branch already has a name, so asking
 * for `<project>/<branch>` asked for both again and took the slash as its own
 * punctuation. Branch names contain slashes of their own: `feature/remote` is
 * one branch, not a project called feature.
 */

/** `git@github.com:symbolica-ai/robotics-server.git` -> `robotics-server` */
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

/** Branches whose session is named after the repository alone. */
const DEFAULT_BRANCHES = ['main', 'master'];

/**
 * What the session for a branch of a repository is called.
 *
 * The repository's name on its own for the default branch, since that is the
 * one people mean, and the branch appended for any other. A name given
 * explicitly wins over both.
 */
export function sessionName(repo: string, branch: string, given?: string): string {
    if (given !== undefined && given.trim() !== '') return safe(given.trim());
    const project = repoName(repo);
    return DEFAULT_BRANCHES.includes(branch) ? project : `${project}-${branchSlug(branch)}`;
}

/** What was asked for, from the words after `/remote project`. */
export interface ProjectRequest {
    readonly repo: string;
    readonly branch: string;
    readonly host: string | null;
    readonly name: string | null;
}

const DEFAULT_BRANCH = 'main';

/**
 * Read `<repo> [branch] [user@host] [as <name>]`, in any order after the repo.
 *
 * A host is recognised by its shape rather than its place, because `user@host`
 * cannot be mistaken for a branch, and a person should not have to remember
 * which position it was.
 */
export function parseProjectRequest(words: readonly string[]): ProjectRequest | null {
    const repo = words[0];
    if (repo === undefined) return null;

    let branch: string | null = null;
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
        if (host === null && /@/.test(word)) {
            host = word;
            continue;
        }
        if (branch === null) {
            branch = word;
            continue;
        }
    }

    return { repo, branch: branch ?? DEFAULT_BRANCH, host, name };
}
