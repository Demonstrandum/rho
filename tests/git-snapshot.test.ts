import { describe, expect, test } from 'bun:test';
import { parseBranchLine, render, renderFailure, snapshot, type Snapshot } from '../extensions/lib/git/git-snapshot';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base: Snapshot = {
    branch: 'master',
    tracking: null,
    changes: [],
    hidden: 0,
    commits: [],
};

describe('parseBranchLine', () => {
    test('a branch with no upstream has no tracking line', () => {
        expect(parseBranchLine('## master')).toEqual({ branch: 'master', tracking: null });
    });

    test('an upstream with no divergence reads as up to date', () => {
        expect(parseBranchLine('## master...origin/master')).toEqual({
            branch: 'master',
            tracking: 'up to date with origin/master',
        });
    });

    test('divergence is carried verbatim', () => {
        expect(parseBranchLine('## master...origin/master [ahead 8]')).toEqual({
            branch: 'master',
            tracking: 'ahead 8 of origin/master',
        });
        expect(parseBranchLine('## dev...origin/dev [ahead 2, behind 1]').tracking)
            .toBe('ahead 2, behind 1 of origin/dev');
    });

    test('a detached head keeps its own name', () => {
        expect(parseBranchLine('## HEAD (no branch)').branch).toBe('HEAD (no branch)');
    });
});

describe('render', () => {
    test('a clean tree says clean', () => {
        const out = render(base);
        expect(out).toContain('branch: master');
        expect(out).toContain('status: clean');
        expect(out).toContain('does not update');
    });

    test('dirty entries are listed under status', () => {
        const out = render({ ...base, changes: [' M AGENTS.md', '?? new.ts'] });
        expect(out).toContain('status:\n   M AGENTS.md\n  ?? new.ts');
        expect(out).not.toContain('clean');
    });

    test('a truncated list reports what it dropped', () => {
        expect(render({ ...base, changes: [' M a'], hidden: 12 })).toContain('and 12 more');
    });

    test('a detached head is named rather than left blank', () => {
        expect(render({ ...base, branch: null }).split('\n')[1]).toBe('branch: detached');
    });

    test('commits render newest first, one per line', () => {
        const out = render({ ...base, commits: ['abc1234 newest', 'def5678 older'] });
        expect(out).toContain('recent:\n  abc1234 newest\n  def5678 older');
    });
});

describe('snapshot', () => {
    test('reads this repository', async () => {
        const reading = await snapshot({ cwd: process.cwd(), commits: 2, maxFiles: 5, timeoutMs: 5_000 });
        expect(reading.kind).toBe('snapshot');
        if (reading.kind !== 'snapshot') return;
        expect(reading.state.branch).toBeTruthy();
        expect(reading.state.commits.length).toBeGreaterThan(0);
    });

    test('a directory outside a work tree is named as such', async () => {
        const outside = mkdtempSync(join(tmpdir(), 'rho-nogit-'));
        const reading = await snapshot({ cwd: outside, commits: 2, maxFiles: 5, timeoutMs: 5_000 });
        expect(reading).toEqual({ kind: 'failed', failure: { reason: 'not-a-repo' } });
        expect(renderFailure({ reason: 'not-a-repo' })).toBeNull();
    });

    test('a timeout is a failed read, not a directory without a repo', async () => {
        const reading = await snapshot({ cwd: process.cwd(), commits: 2, maxFiles: 5, timeoutMs: 1 });
        expect(reading.kind).toBe('failed');
        if (reading.kind !== 'failed') return;
        expect(reading.failure.reason).toBe('unavailable');
    });
});

describe('renderFailure', () => {
    test('a failed read says the tree was not read', () => {
        const out = renderFailure({ reason: 'unavailable', detail: 'git: command not found' });
        expect(out).toContain('git could not be read: git: command not found');
        expect(out).toContain('nothing is known about the work tree');
        expect(out).not.toContain('status: clean');
    });
});
