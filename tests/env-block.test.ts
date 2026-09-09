import { describe, expect, test } from 'bun:test';
import { render, type RenderFields } from '../extensions/env-block';

const facts = {
    cwd: '/Users/samuel/Code/rho',
    repo: true,
    platform: 'darwin 25.5.0',
    date: '2026-09-07',
    model: 'anthropic/claude-opus-4-5, thinking high',
};

const all: RenderFields = { git: true, platform: true, date: true, model: true };

describe('render', () => {
    test('names every fact inside one block', () => {
        expect(render(facts, all)).toBe(
            [
                '<env>',
                'cwd: /Users/samuel/Code/rho',
                'git repo: yes',
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
        const out = render(facts, { git: false, platform: false, date: false, model: false });
        expect(out).toBe('<env>\ncwd: /Users/samuel/Code/rho\n</env>');
    });

    test('a directory that is not a work tree says so', () => {
        expect(render({ ...facts, repo: false }, all)).toContain('git repo: no');
    });
});
