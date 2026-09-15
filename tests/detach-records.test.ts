import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { keptHere, recall, remember } from '../extensions/detach';

/**
 * The record is what makes a name outlive its socket: without it a session
 * retired for being idle took its name with it, and its transcript was a uuid
 * nobody had written down.
 */
const NAME = 'rho-test-kept-session';
const where = join(homedir(), '.local', 'state', 'rho', 'sessions', NAME);

afterEach(() => rmSync(where, { recursive: true, force: true }));

describe('what a detached name refers to', () => {
    test('a name that was never detached refers to nothing', () => {
        expect(recall(NAME)).toBeNull();
    });

    test('what is written down is what comes back', () => {
        remember(NAME, { file: '/tmp/a.jsonl', cwd: '/tmp/work' });
        expect(recall(NAME)).toEqual({ file: '/tmp/a.jsonl', cwd: '/tmp/work' });
        expect(keptHere()).toContain(NAME);
    });

    test('a record written by a later version, or damaged, is refused rather than half-read', () => {
        mkdirSync(where, { recursive: true });
        writeFileSync(join(where, 'local.json'), '{"version":1,"file":"/tmp/a.jsonl"}\n');
        expect(recall(NAME)).toBeNull();
        writeFileSync(join(where, 'local.json'), 'not json at all');
        expect(recall(NAME)).toBeNull();
    });
});
