import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectPlan } from '../extensions/lib/remote/project';
import { projectSource } from '../extensions/lib/remote/naming';

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
    const plan = (branch: string, name?: string) =>
        projectPlan({ source: projectSource(repo), branch, name: name ?? null });

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

    test('a project already here is named rather than cloned again', () => {
        // The clone is under the repository's directory name, which the name
        // of the project does not have to match, so it is found rather than
        // computed.
        const named = projectPlan({ source: projectSource('other'), branch: 'topic' });
        const done = run(named.script, home);
        expect(done.status).toBe(0);
        expect(done.stdout.trim().split('\n').pop()).toBe(named.worktree.replace('$HOME', home));
        expect(existsSync(join(home, 'projects', 'other', 'worktrees', 'topic'))).toBe(true);
    });

    test('a fetch that fails leaves the branch made from what is already cloned', () => {
        const checkout = join(home, 'projects', 'example', 'checkout', 'example');
        mkdirSync(join(home, 'projects', 'example', 'checkout'), { recursive: true });
        spawnSync('git', ['clone', '--quiet', repo, checkout]);
        spawnSync('git', ['-C', checkout, 'remote', 'set-url', 'origin', '/nowhere/at/all.git']);
        const plan = projectPlan({ source: projectSource('example'), branch: 'offline' });
        const done = run(plan.script, home);
        expect(done.status).toBe(0);
        expect(done.stderr).toContain('could not fetch');
        expect(existsSync(plan.worktree.replace('$HOME', home))).toBe(true);
    });

    test('a project nobody has checked out says so rather than cloning nothing', () => {
        const done = run(projectPlan({ source: projectSource('absent'), branch: 'main' }).script, home);
        expect(done.status).not.toBe(0);
        expect(done.stderr).toContain('no project called absent here');
    });

    test('a new branch starts where from says', () => {
        const plan = projectPlan({ source: projectSource(repo), branch: 'topic-two', base: 'feature/one' });
        const done = run(plan.script, home);
        expect(done.status).toBe(0);
        const tree = plan.worktree.replace('$HOME', home);
        const at = spawnSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
        const want = spawnSync('git', ['-C', repo, 'rev-parse', 'feature/one'], { encoding: 'utf8' }).stdout.trim();
        expect(at).toBe(want);
    });

    test('a base that is nowhere is a refusal, not a branch off the wrong commit', () => {
        const plan = projectPlan({ source: projectSource(repo), branch: 'topic-three', base: 'no-such-branch' });
        const done = run(plan.script, home);
        expect(done.status).not.toBe(0);
        expect(done.stderr).toContain('no no-such-branch here to start topic-three from');
        expect(existsSync(plan.worktree.replace('$HOME', home))).toBe(false);
    });

    test('the clone itself holds no branch, so every branch is free for a worktree', () => {
        const checkout = (plan('main').checkout as string).replace('$HOME', home);
        const head = spawnSync('git', ['-C', checkout, 'symbolic-ref', '-q', 'HEAD'], { encoding: 'utf8' });
        // A detached HEAD has no symbolic ref, which is what makes the clone a
        // store of objects rather than a working copy competing for branches.
        expect(head.status).not.toBe(0);
    });
});
