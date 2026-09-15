import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectPlan } from '../extensions/lib/remote/project';

/**
 * Against a real repository on disk, because every one of these failures was a
 * git refusal that the plan did not anticipate, and a mocked git refuses
 * nothing.
 */
const run = (script: string, home: string) =>
    spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: home } });

const origin = (): string => {
    const where = mkdtempSync(join(tmpdir(), 'rho-origin-'));
    const git = (...args: string[]) => spawnSync('git', ['-C', where, ...args], { encoding: 'utf8' });
    git('init', '--quiet', '--initial-branch=main');
    spawnSync('bash', ['-c', `echo hello > ${join(where, 'README.md')}`]);
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'first');
    git('branch', 'feature/one');
    return where;
};

describe('checking out a project', () => {
    const repo = origin();
    const home = mkdtempSync(join(tmpdir(), 'rho-home-'));
    const plan = (branch: string, name?: string) => projectPlan(repo, branch, name);

    test('the default branch works, which a clone leaves checked out', () => {
        const done = run(plan('main').script, home);
        expect(done.status).toBe(0);
        expect(done.stdout.trim().split('\n').pop()).toBe(plan('main').worktree.replace('$HOME', home));
    });

    test('asking twice lands in the same worktree rather than failing', () => {
        const done = run(plan('main').script, home);
        expect(done.status).toBe(0);
        expect(done.stderr).not.toContain('already used by worktree');
    });

    test('a worktree whose directory has gone is recovered, not refused', () => {
        rmSync(plan('main').worktree.replace('$HOME', home), { recursive: true, force: true });
        const done = run(plan('main').script, home);
        expect(done.status).toBe(0);
        expect(done.stderr).not.toContain('already registered');
        expect(existsSync(plan('main').worktree.replace('$HOME', home))).toBe(true);
    });

    test('a branch with a slash is one worktree, not a nested directory', () => {
        const done = run(plan('feature/one').script, home);
        expect(done.status).toBe(0);
        expect(plan('feature/one').worktree).toContain('feature-one');
    });

    test('a second project of the same repository gets its own clone', () => {
        const done = run(plan('main', 'other').script, home);
        expect(done.status).toBe(0);
        expect(done.stdout).toContain(join(home, 'projects', 'other'));
    });

    test('the clone itself holds no branch, so every branch is free for a worktree', () => {
        const checkout = plan('main').checkout.replace('$HOME', home);
        const head = spawnSync('git', ['-C', checkout, 'symbolic-ref', '-q', 'HEAD'], { encoding: 'utf8' });
        // A detached HEAD has no symbolic ref, which is what makes the clone a
        // store of objects rather than a working copy competing for branches.
        expect(head.status).not.toBe(0);
    });
});
