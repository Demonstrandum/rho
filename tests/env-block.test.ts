import { describe, expect, test } from 'bun:test';
import { probeRepo, render, type RenderFields } from '../extensions/env-block';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const facts = {
    cwd: '/Users/samuel/Code/rho',
    repo: 'yes' as const,
    platform: 'darwin 25.5.0',
    date: '2026-09-07',
    model: 'anthropic/claude-opus-4-5, thinking high',
    shell: '/bin/zsh',
};

const all: RenderFields = { git: true, platform: true, date: true, model: true, shell: true };

describe('render', () => {
    test('names every fact inside one block', () => {
        expect(render(facts, all)).toBe(
            [
                '<env>',
                'cwd: /Users/samuel/Code/rho',
                'git repo: yes',
                'shell: /bin/zsh',
                'platform: darwin 25.5.0',
                'date: 2026-09-07',
                'model: anthropic/claude-opus-4-5, thinking high',
                '</env>',
            ].join('\n'),
        );
    });

    test('a disabled field leaves no line behind', () => {
        const out = render(facts, { ...all, platform: false, date: false });
        expect(out).not.toContain('platform');
        expect(out).not.toContain('date');
        expect(out).toContain('git repo: yes');
    });

    test('the working directory is always named', () => {
        const out = render(facts, { git: false, platform: false, date: false, model: false, shell: false });
        expect(out).toBe('<env>\ncwd: /Users/samuel/Code/rho\n</env>');
    });

    test('a remote machine is named first, so the directory is not read as local', () => {
        const out = render({ ...facts, host: 'samuel@dev-box', shell: '/run/current-system/sw/bin/bash' }, all);
        expect(out.split('\n')[1]).toBe('host: samuel@dev-box');
        expect(out).toContain('shell: /run/current-system/sw/bin/bash');
    });

    test('no host line when the tools act on this machine', () => {
        expect(render(facts, all)).not.toContain('host:');
    });

    test('a directory that is not a work tree says so', () => {
        expect(render({ ...facts, repo: 'no' }, all)).toContain('git repo: no');
    });

    test('a probe that never ran is not reported as a directory without a repo', () => {
        const out = render({ ...facts, repo: 'unknown' }, all);
        expect(out).not.toContain('git repo: no');
        expect(out).toContain('git repo: could not be determined');
    });
});

describe('probeRepo', () => {
    test('a work tree answers yes', async () => {
        expect(await probeRepo(process.cwd())).toBe('yes');
    });

    test('a directory outside a work tree answers no', async () => {
        expect(await probeRepo(mkdtempSync(join(tmpdir(), 'rho-nogit-')))).toBe('no');
    });

    test('a probe that cannot run answers unknown', async () => {
        const path = process.env.PATH;
        process.env.PATH = join(tmpdir(), 'rho-empty-path');
        try {
            expect(await probeRepo(process.cwd())).toBe('unknown');
        } finally {
            process.env.PATH = path;
        }
    });
});
