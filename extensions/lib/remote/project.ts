/**
 * Where a project lives on a machine, and the shell that puts it there.
 *
 * One clone, many worktrees:
 *
 *   ~/projects/<project>/checkout/<repo>      the clone
 *   ~/projects/<project>/worktrees/<branch>   where work happens
 *
 * Ten branches then cost one clone rather than ten, and every machine the
 * agent works on has the same shape, so a path learnt on one is a path on the
 * next.
 *
 * A project can be asked for by its repository, which clones it, or by the
 * name of one already here, which finds the clone under ~/projects/<name> and
 * adds a worktree to it. The second is how people refer to a project once it
 * exists, and it does not oblige them to hold the URL again.
 *
 * The script lives here rather than inside the command that first needed it,
 * because `/remote project` is not the only way to ask for a checkout: the
 * agent also asks for one on whatever machine it is currently attached to, and
 * two copies of this would drift into two layouts.
 */

import { branchSlug, projectNameOf, repoName } from './naming';
import type { ProjectSource } from './naming';

export interface ProjectPlan {
    /** the shell to run on the machine that will hold it. */
    readonly script: string;
    /** where the work will be, once it has run. */
    readonly worktree: string;
    /**
     * the clone the worktree hangs off, when the plan knows it.
     *
     * A project named rather than cloned keeps its clone under whatever
     * directory name the repository had, which only the machine holding it
     * can say, so the script finds it and this is null.
     */
    readonly checkout: string | null;
}

export interface ProjectAsked {
    readonly source: ProjectSource;
    readonly branch: string;
    /** where a branch that does not exist yet starts. Defaults to origin's own HEAD. */
    readonly base?: string | null;
    /** the directory under ~/projects. Defaults to the source's own name. */
    readonly name?: string | null;
}

/** A word as one shell argument, whatever is in it. Not for a path holding $HOME. */
const sh = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

/** How much of a failing script's output to report. */
const COMPLAINT_LINES = 6;

/**
 * What a script that failed said, as something a person can act on.
 *
 * The last line alone was what this used to report, and git's refusals end on
 * their least useful line: a checkout that could not authenticate said "and
 * the repository exists", which is the fourth line of a message whose first
 * line names the key that was offered and whose third line says the access
 * rights are the problem. The tail carries the whole refusal.
 */
export function scriptComplaint(text: string, code: number | null): string {
    const lines = text
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    if (lines.length === 0) return `it exited ${code}`;
    return lines.slice(-COMPLAINT_LINES).join('\n');
}

/** Said when the clone could not be brought up to date, and was used as it stood. */
const STALE = "'could not fetch: working from what is already cloned'";

export function projectPlan(asked: ProjectAsked): ProjectPlan {
    const { source, branch } = asked;
    const project = asked.name ?? projectNameOf(source);
    const root = `$HOME/projects/${project}`;
    // The branch as a directory name, not as a path: `feature/remote` is one
    // branch, and a directory of that name would nest it under a directory
    // called feature that no other branch could share.
    const worktree = `${root}/worktrees/${branchSlug(branch)}`;
    const checkout = source.kind === 'repository' ? `${root}/checkout/${repoName(source.repo)}` : null;

    // Where the clone comes from: cloned when a repository was given, found
    // when a project was named. Both leave it in $checkout, so everything
    // after this point is one piece of shell.
    const obtain =
        source.kind === 'repository'
            ? [
                  `mkdir -p ${root}/checkout`,
                  `checkout="${checkout as string}"`,
                  // Idempotent: running it twice fetches rather than failing, so a
                  // second worktree on an existing project is one command.
                  //
                  // A fetch that fails does not stop the checkout. The clone
                  // is already here, so the branch can be made from what it
                  // holds; refusing instead turned an expired credential, a
                  // cloud that was down, and a machine with no network into
                  // "could not check out", with nothing made.
                  'if [ -d "$checkout/.git" ]; then',
                  `  git -C "$checkout" fetch --all --prune || echo ${STALE} >&2;`,
                  `else git clone ${sh(source.repo)} "$checkout"; fi`,
              ]
            : [
                  // The clone is already here, under whatever directory name
                  // the repository had. Finding it is what lets a second
                  // branch be asked for by the project's name alone, without
                  // the URL, which is how people refer to it once it exists.
                  'checkout=""',
                  `for candidate in ${root}/checkout/*; do`,
                  '  if [ -d "$candidate/.git" ]; then checkout="$candidate"; break; fi',
                  'done',
                  'if [ -z "$checkout" ]; then',
                  `  echo ${sh(`no project called ${project} here: give the repository to clone it`)} >&2; exit 1;`,
                  'fi',
                  `git -C "$checkout" fetch --all --prune || echo ${STALE} >&2`,
              ];

    // Where a branch that does not exist yet starts. Asked for explicitly it
    // must resolve, since starting from the wrong commit is worse than a
    // refusal. Left out, it is origin's own default branch: the clone sits
    // detached at whatever it was cloned at, which a later fetch does not move.
    const start =
        asked.base === undefined || asked.base === null
            ? ['    start=$(git -C "$checkout" symbolic-ref --quiet --short refs/remotes/origin/HEAD || echo HEAD)']
            : [
                  `    if git -C "$checkout" show-ref --verify --quiet ${sh(`refs/remotes/origin/${asked.base}`)}; then`,
                  `      start=${sh(`origin/${asked.base}`)};`,
                  `    elif git -C "$checkout" show-ref --verify --quiet ${sh(`refs/heads/${asked.base}`)}; then`,
                  `      start=${sh(asked.base)};`,
                  `    else`,
                  `      echo ${sh(`no ${asked.base} here to start ${branch} from`)} >&2; exit 1;`,
                  `    fi`,
              ];

    const script = [
        'set -e',
        // The machine may never have spoken to this cloud before, and a first
        // clone otherwise dies on "Host key verification failed" with no way
        // to answer the prompt. accept-new trusts an unknown host once and
        // still refuses one whose key has changed.
        'export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"',
        ...obtain,
        `mkdir -p ${root}/worktrees`,
        // The clone holds a branch checked out, and git refuses a worktree for
        // a branch that is already checked out somewhere: asking for the
        // repository's default branch failed with "'main' is already used by
        // worktree at <checkout>", which is the first thing anybody asks for.
        // Detaching the clone makes it what it is meant to be here, a store of
        // objects, and leaves every branch free for a worktree.
        'git -C "$checkout" checkout --quiet --detach',
        // A worktree whose directory has gone stays registered, and every
        // later checkout of that branch then fails with "missing but already
        // registered worktree". Directories do go: a node is reclaimed, a
        // disk is cleared, somebody deletes one by hand after a failed run.
        // Pruning first costs nothing and removes only registrations whose
        // directory is already absent.
        'git -C "$checkout" worktree prune',
        // An existing worktree is reused rather than refused: asking for the
        // same branch twice should land you in it, not error.
        `if [ ! -d "${worktree}" ]; then`,
        `  if git -C "$checkout" show-ref --verify --quiet ${sh(`refs/heads/${branch}`)}; then`,
        // The branch may be checked out in another worktree of this clone,
        // which git refuses rather than sharing. Sending this one to the same
        // commit, detached, gives the files that were asked for instead of an
        // error about a directory the person has never seen.
        `    git -C "$checkout" worktree add "${worktree}" ${sh(branch)} ||`,
        `      git -C "$checkout" worktree add --detach "${worktree}" ${sh(branch)};`,
        `  elif git -C "$checkout" show-ref --verify --quiet ${sh(`refs/remotes/origin/${branch}`)}; then`,
        `    git -C "$checkout" worktree add --track -b ${sh(branch)} "${worktree}" ${sh(`origin/${branch}`)};`,
        `  else`,
        ...start,
        `    git -C "$checkout" worktree add -b ${sh(branch)} "${worktree}" "$start";`,
        `  fi;`,
        'fi',
        `echo "${worktree}"`,
    ].join('\n');

    return { script, worktree, checkout };
}
