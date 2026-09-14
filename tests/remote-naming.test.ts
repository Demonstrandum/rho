import { describe, expect, test } from 'bun:test';
import { branchSlug, parseProjectRequest, repoName, sessionName } from '../extensions/lib/remote/naming';

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
        expect(sessionName('git@github.com:x/demo-server.git', 'main')).toBe('demo-server');
        expect(sessionName('git@github.com:x/demo-server.git', 'master')).toBe('demo-server');
        expect(sessionName('git@github.com:x/demo-server.git', 'feature/remote')).toBe(
            'demo-server-feature-remote',
        );
    });

    test('a name given by hand wins', () => {
        expect(sessionName('git@github.com:x/demo-server.git', 'main', 'rv')).toBe('rv');
    });
});

describe('reading what was asked for', () => {
    test('a repository alone is the default branch on the usual host', () => {
        expect(parseProjectRequest(['git@github.com:x/rho.git'])).toEqual({
            repo: 'git@github.com:x/rho.git',
            branch: 'main',
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

    test('nothing asked for is nothing to do', () => {
        expect(parseProjectRequest([])).toBeNull();
    });
});
