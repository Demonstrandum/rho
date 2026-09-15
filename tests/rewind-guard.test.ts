import { test, expect } from 'bun:test';
import {
    shouldCheckpoint,
    checkpointBlock,
    blockLine,
    failureAction,
    probeDetail,
    type DirectoryFacts,
} from '../extensions/rewind-guard';

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

test('a work tree git cannot scan is refused before the first turn', () => {
    const block = checkpointBlock('git', {
        ...repo,
        staging: { ok: false, detail: "fatal: 'git status --porcelain=2' failed in submodule .pi/agent" },
    });
    expect(block?.kind).toBe('staging-fails');
    expect(blockLine(block!, repo.cwd)).toBe(
        "/rewind is off here: git cannot stage /Users/x/code/thing (fatal: 'git status --porcelain=2' failed in submodule .pi/agent).",
    );
});

test('a directory that is not a repo says so in one line', () => {
    expect(blockLine(checkpointBlock('git', loose)!, loose.cwd)).toBe(
        '/rewind is off here: /Users/x/notes is not a git repo.',
    );
});

test("the reader's own 'never' is not announced", () => {
    expect(blockLine(checkpointBlock('never', repo)!, repo.cwd)).toBeUndefined();
});

test("neither of pi-rewind's failure wordings reaches the reader", () => {
    // the turn-end path says "finalization" and the turn-start path does not;
    // one unreadable work tree produces both, every turn.
    expect(failureAction('Checkpoint failed: git add')).toBe('drop');
    expect(failureAction('Checkpoint finalization failed: git add')).toBe('drop');
    expect(failureAction('Files restored')).toBe('pass');
});

test('the failure detail is the fatal line, not the whole of stderr', () => {
    const stderr = 'warning: could not open directory\nfatal: this operation must be run in a work tree\n';
    expect(probeDetail(stderr, false)).toBe('fatal: this operation must be run in a work tree');
    expect(probeDetail('', true)).toBe('no answer in 5s');
    expect(probeDetail('', false)).toBe('git exited non-zero');
    expect(probeDetail(`fatal: ${'x'.repeat(200)}`, false).length).toBe(120);
});

test('always and never ignore the directory', () => {
    for (const facts of [repo, loose, home]) {
        expect(shouldCheckpoint('always', facts)).toBe(true);
        expect(shouldCheckpoint('never', facts)).toBe(false);
    }
    // 'always' is a decision the reader has already made, scan or no scan.
    expect(shouldCheckpoint('always', { ...repo, staging: { ok: false, detail: 'fatal: x' } })).toBe(true);
});
