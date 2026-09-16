import { describe, expect, test } from 'bun:test';
import {
    branchSlug,
    parseProjectRequest,
    projectSource,
    repoName,
    sessionName,
} from '../extensions/lib/remote/naming';

describe('what a project is called', () => {
    test('the repository already has a name', () => {
        expect(repoName('git@github.com:example-org/demo-server.git')).toBe('demo-server');
        expect(repoName('https://github.com/example-org/rho.git')).toBe('rho');
        expect(repoName('/srv/git/mock')).toBe('mock');
    });

    test('a branch keeps its slashes as a name and loses them as a path', () => {
        expect(branchSlug('feature/remote')).toBe('feature-remote');
        expect(branchSlug('main')).toBe('main');
    });

    test('the default branch is the repository, another branch says which', () => {
        const repo = projectSource('git@github.com:x/demo-server.git');
        expect(sessionName(repo, 'main')).toBe('demo-server');
        expect(sessionName(repo, 'master')).toBe('demo-server');
        expect(sessionName(repo, 'feature/remote')).toBe('demo-server-feature-remote');
    });

    test('a name given by hand wins', () => {
        expect(sessionName(projectSource('git@github.com:x/demo-server.git'), 'main', 'rv')).toBe('rv');
    });

    test('a project already here is named, not cloned', () => {
        expect(projectSource('rho')).toEqual({ kind: 'project', project: 'rho' });
        expect(projectSource('git@github.com:x/rho.git')).toEqual({
            kind: 'repository',
            repo: 'git@github.com:x/rho.git',
        });
        expect(projectSource('/srv/git/mock')).toEqual({ kind: 'repository', repo: '/srv/git/mock' });
        expect(projectSource('mock.git')).toEqual({ kind: 'repository', repo: 'mock.git' });
        // A project named alone still names the session after itself.
        expect(sessionName(projectSource('rho'), 'feature/remote')).toBe('rho-feature-remote');
    });
});

describe('reading what was asked for', () => {
    test('a repository alone is the default branch on the usual host', () => {
        expect(parseProjectRequest(['git@github.com:x/rho.git'])).toEqual({
            source: { kind: 'repository', repo: 'git@github.com:x/rho.git' },
            branch: 'main',
            base: null,
            host: null,
            name: null,
        });
    });

    test('a branch with slashes stays one branch', () => {
        expect(parseProjectRequest(['repo.git', 'feature/remote'])?.branch).toBe('feature/remote');
    });

    test('the host is known by its shape, not by its place', () => {
        const before = parseProjectRequest(['repo.git', 'samuel@dev-box', 'topic']);
        expect(before?.host).toBe('samuel@dev-box');
        expect(before?.branch).toBe('topic');
        const after = parseProjectRequest(['repo.git', 'topic', 'samuel@dev-box']);
        expect(after?.host).toBe('samuel@dev-box');
        expect(after?.branch).toBe('topic');
    });

    test('a name can be given, after as', () => {
        const asked = parseProjectRequest(['repo.git', 'topic', 'samuel@dev-box', 'as', 'rv']);
        expect(asked?.name).toBe('rv');
        expect(asked?.branch).toBe('topic');
    });

    test('a base for a branch that does not exist yet, after from', () => {
        const asked = parseProjectRequest(['rho', 'topic', 'from', 'release/2', 'as', 'rv']);
        expect(asked?.base).toBe('release/2');
        expect(asked?.branch).toBe('topic');
        expect(asked?.name).toBe('rv');
        expect(parseProjectRequest(['rho', 'topic'])?.base).toBeNull();
    });

    test('nothing asked for is nothing to do', () => {
        expect(parseProjectRequest([])).toBeNull();
    });
});
