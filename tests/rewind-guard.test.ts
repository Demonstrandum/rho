import { test, expect } from 'bun:test';
import { shouldCheckpoint, type DirectoryFacts } from '../extensions/rewind-guard';

const repo: DirectoryFacts = { cwd: '/Users/x/code/thing', home: '/Users/x', insideGitWorkTree: true };
const loose: DirectoryFacts = { cwd: '/Users/x/notes', home: '/Users/x', insideGitWorkTree: false };
const home: DirectoryFacts = { cwd: '/Users/x', home: '/Users/x', insideGitWorkTree: true };

test('git mode checkpoints inside a work tree', () => {
    expect(shouldCheckpoint('git', repo)).toBe(true);
});

test('git mode leaves a directory that is not a work tree alone', () => {
    expect(shouldCheckpoint('git', loose)).toBe(false);
});

test('the home directory is excluded even when it is a work tree', () => {
    // a dotfiles repo in home would otherwise stage everything under home on
    // every turn, which is what times out.
    expect(shouldCheckpoint('git', home)).toBe(false);
});

test('a trailing separator does not make home look like another directory', () => {
    expect(shouldCheckpoint('git', { ...home, cwd: '/Users/x/' })).toBe(false);
});

test('always and never ignore the directory', () => {
    for (const facts of [repo, loose, home]) {
        expect(shouldCheckpoint('always', facts)).toBe(true);
        expect(shouldCheckpoint('never', facts)).toBe(false);
    }
});
