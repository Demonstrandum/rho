// reads the state of a git work tree once, and renders it for the prompt.
//
// separated from the extension so the rendering is testable without a repo and
// without a session: `snapshot()` shells out, `render()` is a pure function of
// what it found.

export interface Snapshot {
    /** `master`, or null outside a work tree */
    readonly branch: string | null;
    /** `2 ahead of origin/master`, `up to date`, or null with no upstream */
    readonly tracking: string | null;
    /** porcelain entries, already capped */
    readonly changes: readonly string[];
    /** how many entries were dropped by the cap */
    readonly hidden: number;
    /** `<sha> <subject>` lines, newest first */
    readonly commits: readonly string[];
}

/**
 * why a git read produced no snapshot. the two cases are different facts about
 * the session and must not share a representation: `not-a-repo` is a statement
 * about the directory, `unavailable` is a statement about the read, and printing
 * the second as the first tells the agent something false about where it stands.
 */
export type Failure =
    | { readonly reason: 'not-a-repo' }
    | { readonly reason: 'unavailable'; readonly detail: string };

export type Reading =
    | { readonly kind: 'snapshot'; readonly state: Snapshot }
    | { readonly kind: 'failed'; readonly failure: Failure };

export interface SnapshotOptions {
    readonly cwd: string;
    readonly commits: number;
    readonly maxFiles: number;
    readonly timeoutMs: number;
}

import { runGit } from './run-git';

type Run = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly failure: Failure };

// LC_ALL=C so the message below is the one git prints, whatever the user's
// locale. the alternative is reading exit 128, which git uses for every fatal
// error and not only for a directory outside a work tree.
const OUTSIDE_WORK_TREE = /not a git repository/i;

const run = async (args: readonly string[], cwd: string, timeoutMs: number): Promise<Run> => {
    // Through runGit, so this works under node as well as bun: the agent on
    // another machine runs under whichever of them that machine can give it.
    const answer = await runGit(args, cwd, timeoutMs);
    if (answer.ok) return { ok: true, text: answer.text };
    if (answer.code === null) return { ok: false, failure: { reason: 'unavailable', detail: answer.errors } };
    if (answer.timedOut) {
        return { ok: false, failure: { reason: 'unavailable', detail: `git ${args[0]} timed out after ${timeoutMs}ms` } };
    }
    if (OUTSIDE_WORK_TREE.test(answer.errors)) return { ok: false, failure: { reason: 'not-a-repo' } };
    const first = answer.errors.split('\n').find((line) => line.length > 0) ?? `git ${args[0]} exited non-zero`;
    return { ok: false, failure: { reason: 'unavailable', detail: first } };
};

/**
 * the branch header porcelain v2 emits, e.g.
 *   ## master...origin/master [ahead 8, behind 1]
 *   ## master
 *   ## HEAD (no branch)
 */
export const parseBranchLine = (line: string): Pick<Snapshot, 'branch' | 'tracking'> => {
    const body = line.replace(/^## /, '');
    const divergence = body.match(/\[(.+)\]$/);
    const names = body.replace(/\s*\[.+\]$/, '');
    const [branch, upstream] = names.split('...');
    if (upstream === undefined) return { branch, tracking: null };
    return {
        branch,
        tracking: divergence === null ? `up to date with ${upstream}` : `${divergence[1]} of ${upstream}`,
    };
};

export const snapshot = async (options: SnapshotOptions): Promise<Reading> => {
    const { cwd, commits, maxFiles, timeoutMs } = options;
    const status = await run(['status', '--porcelain=v1', '-b'], cwd, timeoutMs);
    if (!status.ok) return { kind: 'failed', failure: status.failure };

    const lines = status.text.split('\n').filter((line) => line.length > 0);
    const header = lines.find((line) => line.startsWith('## ')) ?? '## HEAD';
    const entries = lines.filter((line) => !line.startsWith('## '));

    // an empty repository has no commits, so a failed log is not a failed read.
    const log = await run(['log', `-${commits}`, '--format=%h %s'], cwd, timeoutMs);

    return {
        kind: 'snapshot',
        state: {
            ...parseBranchLine(header),
            changes: entries.slice(0, maxFiles),
            hidden: Math.max(0, entries.length - maxFiles),
            commits: log.ok ? log.text.split('\n').filter((line) => line.length > 0) : [],
        },
    };
};

/**
 * a read that failed gets a block of its own. the agent is told the tree was not
 * read, rather than being left to infer a clean tree from a missing block.
 */
export const renderFailure = (failure: Failure): string | null => {
    if (failure.reason === 'not-a-repo') return null;
    return `<git>\ngit could not be read: ${failure.detail}\nnothing is known about the work tree here; run git yourself before acting on it\n</git>`;
};

export const render = (state: Snapshot): string => {
    const lines: string[] = [];
    const branch = state.branch ?? 'detached';
    lines.push(state.tracking === null ? `branch: ${branch}` : `branch: ${branch} (${state.tracking})`);

    if (state.changes.length === 0) {
        lines.push('status: clean');
    } else {
        lines.push('status:');
        for (const change of state.changes) lines.push(`  ${change}`);
        // the count matters: a truncated list read as complete is worse than no
        // list, because "clean apart from these" is then false.
        if (state.hidden > 0) lines.push(`  and ${state.hidden} more`);
    }

    if (state.commits.length > 0) {
        lines.push('recent:');
        for (const commit of state.commits) lines.push(`  ${commit}`);
    }

    lines.push('taken at session start; it does not update, so read it again before acting on it');
    return `<git>\n${lines.join('\n')}\n</git>`;
};
