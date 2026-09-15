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
 * The script lives here rather than inside the command that first needed it,
 * because `/remote project` is not the only way to ask for a checkout: the
 * agent also asks for one on whatever machine it is currently attached to, and
 * two copies of this would drift into two layouts.
 */

import { branchSlug, repoName } from './naming';

export interface ProjectPlan {
    /** the shell to run on the machine that will hold it. */
    readonly script: string;
    /** where the work will be, once it has run. */
    readonly worktree: string;
    /** the clone the worktree hangs off. */
    readonly checkout: string;
}

export function projectPlan(repo: string, branch: string, projectName?: string): ProjectPlan {
    const project = projectName ?? repoName(repo);
    const name = repoName(repo);
    const root = `$HOME/projects/${project}`;
    const checkout = `${root}/checkout/${name}`;
    // The branch as a directory name, not as a path: `feature/remote` is one
    // branch, and a directory of that name would nest it under a directory
    // called feature that no other branch could share.
    const worktree = `${root}/worktrees/${branchSlug(branch)}`;

    const script = [
        'set -e',
        // The machine may never have spoken to this forge before, and a first
        // clone otherwise dies on "Host key verification failed" with no way
        // to answer the prompt. accept-new trusts an unknown host once and
        // still refuses one whose key has changed.
        'export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"',
        `mkdir -p ${root}/checkout ${root}/worktrees`,
        // Idempotent: running it twice fetches rather than failing, so a second
        // worktree on an existing project is one command.
        `if [ -d ${checkout}/.git ]; then git -C ${checkout} fetch --all --prune;`,
        `else git clone ${JSON.stringify(repo)} ${checkout}; fi`,
        // The clone holds a branch checked out, and git refuses a worktree for
        // a branch that is already checked out somewhere: asking for the
        // repository's default branch failed with "'main' is already used by
        // worktree at <checkout>", which is the first thing anybody asks for.
        // Detaching the clone makes it what it is meant to be here, a store of
        // objects, and leaves every branch free for a worktree.
        `git -C ${checkout} checkout --quiet --detach`,
        // An existing worktree is reused rather than refused: asking for the
        // same branch twice should land you in it, not error.
        `if [ ! -d ${worktree} ]; then`,
        `  if git -C ${checkout} show-ref --verify --quiet refs/heads/${branch}; then`,
        `    git -C ${checkout} worktree add ${worktree} ${branch};`,
        `  elif git -C ${checkout} show-ref --verify --quiet refs/remotes/origin/${branch}; then`,
        `    git -C ${checkout} worktree add --track -b ${branch} ${worktree} origin/${branch};`,
        `  else`,
        `    git -C ${checkout} worktree add -b ${branch} ${worktree};`,
        `  fi;`,
        'fi',
        `echo ${worktree}`,
    ].join('\n');

    return { script, worktree, checkout };
}
