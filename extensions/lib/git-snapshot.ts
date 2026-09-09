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

export interface SnapshotOptions {
    readonly cwd: string;
    readonly commits: number;
    readonly maxFiles: number;
    readonly timeoutMs: number;
}

const run = async (args: readonly string[], cwd: string, timeoutMs: number): Promise<string | null> => {
    try {
        const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const text = await new Response(proc.stdout).text();
        clearTimeout(timer);
        return (await proc.exited) === 0 ? text : null;
    } catch {
        return null;
    }
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

export const snapshot = async (options: SnapshotOptions): Promise<Snapshot | null> => {
    const { cwd, commits, maxFiles, timeoutMs } = options;
    const status = await run(['status', '--porcelain=v1', '-b'], cwd, timeoutMs);
    if (status === null) return null;

    const lines = status.split('\n').filter((line) => line.length > 0);
    const header = lines.find((line) => line.startsWith('## ')) ?? '## HEAD';
    const entries = lines.filter((line) => !line.startsWith('## '));

    const log = await run(['log', `-${commits}`, '--format=%h %s'], cwd, timeoutMs);

    return {
        ...parseBranchLine(header),
        changes: entries.slice(0, maxFiles),
        hidden: Math.max(0, entries.length - maxFiles),
        commits: log === null ? [] : log.split('\n').filter((line) => line.length > 0),
    };
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
