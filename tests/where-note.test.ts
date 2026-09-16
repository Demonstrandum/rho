/**
 * What the agent is told when something moves it.
 *
 * The git read is a runner, so the whole note is testable without a repository
 * and without a machine on the other end of a link.
 */

import { expect, test } from 'bun:test';
import type { GitRunner } from '../extensions/lib/git-snapshot';
import type { Captured } from '../extensions/lib/remote/client';
import { gitThrough, whereNote } from '../extensions/lib/where-note';

const tree: GitRunner = async (args) => {
    if (args[0] === 'status') return { ok: true, text: '## test2...origin/test2 [ahead 1]\n M src/a.ts\n' };
    if (args[0] === 'log') return { ok: true, text: 'abc1234 a commit\n' };
    return { ok: false, code: 1, errors: 'unexpected', timedOut: false };
};

const outside: GitRunner = async () => ({ ok: false, code: 128, errors: 'fatal: not a git repository', timedOut: false });

test('a local move names the directory and the tree', async () => {
    const note = await whereNote('cwd', { host: null, cwd: '/home/samuel/work', git: tree });
    expect(note.content).toContain('cwd: /home/samuel/work');
    expect(note.content).not.toContain('host:');
    expect(note.content).toContain('branch: test2 (ahead 1 of origin/test2)');
    expect(note.branch).toBe('test2');
});

test('a move on another machine names the machine first', async () => {
    const note = await whereNote('project', { host: 'samuel@dev-box', cwd: '/srv/w', git: tree });
    expect(note.content).toContain('host: samuel@dev-box');
    expect(note.host).toBe('samuel@dev-box');
});

test('a directory outside a work tree carries no git block', async () => {
    const note = await whereNote('cwd', { host: null, cwd: '/tmp', git: outside });
    expect(note.content).not.toContain('<git>');
    expect(note.branch).toBeNull();
});

test('git on the far side is one command per question, with the directory quoted', async () => {
    const asked: string[] = [];
    const capture = async (command: string): Promise<Captured> => {
        asked.push(command);
        return { code: 0, stdout: '## main\n', stderr: '' };
    };
    const run = gitThrough(capture);
    const answer = await run(['status', '--porcelain=v1', '-b'], "/srv/it's here", 5000);
    expect(answer.ok).toBe(true);
    expect(asked[0]).toBe("git -C '/srv/it'\\''s here' 'status' '--porcelain=v1' '-b'");
});

test('a failed far-side git is a failure, not an empty tree', async () => {
    const run = gitThrough(async () => ({ code: null, stdout: '', stderr: 'the link closed' }));
    const answer = await run(['status'], '/srv', 5000);
    expect(answer).toEqual({ ok: false, code: null, errors: 'the link closed', timedOut: false });
});
