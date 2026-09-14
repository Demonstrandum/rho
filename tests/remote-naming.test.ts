import { describe, expect, test } from 'bun:test';
import { branchSlug, parseProjectRequest, repoName, sessionName } from '../extensions/lib/remote/naming';

describe('what a project is called', () => {
    test('the repository already has a name', () => {
        expect(repoName('git@github.com:symbolica-ai/robotics-server.git')).toBe('robotics-server');
        expect(repoName('https://github.com/symbolica-ai/rho.git')).toBe('rho');
        expect(repoName('/srv/git/mock')).toBe('mock');
    });

    test('a branch keeps its slashes as a name and loses them as a path', () => {
        expect(branchSlug('feature/remote')).toBe('feature-remote');
        expect(branchSlug('main')).toBe('main');
    });

    test('the default branch is the repository, another branch says which', () => {
        expect(sessionName('git@github.com:x/robotics-server.git', 'main')).toBe('robotics-server');
        expect(sessionName('git@github.com:x/robotics-server.git', 'master')).toBe('robotics-server');
        expect(sessionName('git@github.com:x/robotics-server.git', 'feature/remote')).toBe(
            'robotics-server-feature-remote',
        );
    });

    test('a name given by hand wins', () => {
        expect(sessionName('git@github.com:x/robotics-server.git', 'main', 'rv')).toBe('rv');
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
        const before = parseProjectRequest(['repo.git', 'samuel@robotics-vm', 'topic']);
        expect(before?.host).toBe('samuel@robotics-vm');
        expect(before?.branch).toBe('topic');
        const after = parseProjectRequest(['repo.git', 'topic', 'samuel@robotics-vm']);
        expect(after?.host).toBe('samuel@robotics-vm');
        expect(after?.branch).toBe('topic');
    });

    test('a name can be given, after as', () => {
        const asked = parseProjectRequest(['repo.git', 'topic', 'samuel@robotics-vm', 'as', 'rv']);
        expect(asked?.name).toBe('rv');
        expect(asked?.branch).toBe('topic');
    });

    test('nothing asked for is nothing to do', () => {
        expect(parseProjectRequest([])).toBeNull();
    });
});
