import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import {
    disenshittify,
    disenshittifyMarkdown,
    mask,
    normaliseBullets,
    normaliseCase,
    normaliseCharacters,
    normaliseDashes,
    unmask,
} from '../extensions/lib/disenshittification';

const root = join(import.meta.dir, '..');

test('a dash between clauses becomes the mark the sentence needs', () => {
    expect(disenshittify('a thing \u2014 and another')).toBe('a thing, and another');
    expect(disenshittify('a thing, \u2014 and another')).toBe('a thing, and another');
    expect(disenshittify('the range 2014\u20132018 holds')).toBe('the range 2014-2018 holds');
    expect(disenshittify('teams \u2014\nper-engineer rate')).toBe('teams, per-engineer rate');
    expect(disenshittify('a trailing dash \u2014')).toBe('a trailing dash');
});

test('a protected span keeps its bytes', () => {
    const cases = [
        'run `git diff --no-index` now.',
        'see https://example.com/a\u2014b for it.',
        'the file /Users/Sam/Code/Rho/README.md is there.',
        'read docs/Extensions.md first.',
        '<location>/Users/Sam/Code/rho/skills/auditor/SKILL.md</location>',
        '```\nconst x = a \u2014 b;\n```',
    ];
    for (const sample of cases) expect(disenshittifyMarkdown(sample)).toBe(sample.replace(/^(\w)/, (c) => c.toLowerCase()));
});

test('case falls only at the start of a sentence', () => {
    expect(normaliseCase('Read the file. Then act.')).toBe('read the file. then act.');
    expect(normaliseCase('<description>Review this. Report that.</description>')).toBe(
        '<description>review this. report that.</description>',
    );
    // a capital inside a sentence is a name, an acronym, or deliberate.
    expect(normaliseCase('the Erd\u0151s number and the SDK stay')).toBe('the Erd\u0151s number and the SDK stay');
    expect(normaliseCase('Claude Code keeps both words')).toBe('Claude Code keeps both words');
    // a heading's colon separates a title from a subtitle.
    expect(normaliseCase('# Writer Prompt: Technical Prose')).toBe('# Writer Prompt: Technical Prose');
});

test('a list item is punctuated x; y; z. within its own line', () => {
    expect(normaliseBullets('- do this. then that')).toBe('- do this; then that.');
    expect(normaliseBullets('- ends in a span `--force`')).toBe('- ends in a span `--force`');
    expect(normaliseBullets('- bash: run commands (ls, etc.)')).toBe('- bash: run commands (ls, etc.)');
    // a mapping is data, and a stop would read as part of the value it gives.
    expect(normaliseBullets('  - "seam" -> "whatchamacallit"')).toBe('  - "seam" -> "whatchamacallit"');
    // a line break inside an item is the writer's.
    expect(normaliseBullets('- first sentence.\n  second sentence.')).toBe('- first sentence.\n  second sentence.');
});

test('line structure inside a tag belongs to whoever wrote the block', () => {
    const block = '<env>\ncwd: /tmp\ngit repo: no\nplatform: darwin\n</env>';
    expect(disenshittifyMarkdown(block)).toBe(block);
});

test('every transform is idempotent, and so is the pipeline', () => {
    const sample = readFileSync(join(root, 'AGENTS.md'), 'utf8') + readFileSync(join(root, 'README.md'), 'utf8');
    for (const transform of [normaliseCharacters, normaliseDashes, normaliseCase, normaliseBullets, disenshittify, disenshittifyMarkdown]) {
        const once = transform(sample);
        expect(transform(once)).toBe(once);
    }
});

test('masking round-trips', () => {
    const sample = 'a `code` span, a /Users/Sam/path, a <tag attr="x">, and https://example.com/a';
    const masked = mask(sample);
    expect(unmask(masked)).toBe(sample);
    expect(masked.spans.length).toBeGreaterThan(3);
});

test('every markdown file in rho is a fixed point of the rewrite', async () => {
    const patterns = ['*.md', 'system/**/*.md', 'skills/**/*.md', 'docs/**/*.md', 'prompts/**/*.md'];
    const files = new Set<string>();
    for (const pattern of patterns) {
        for await (const file of new Glob(pattern).scan(root)) files.add(file);
    }
    expect(files.size).toBeGreaterThan(10);
    const changed = [...files].filter((file) => {
        const source = readFileSync(join(root, file), 'utf8');
        return disenshittifyMarkdown(source) !== source;
    });
    expect(changed).toEqual([]);
});
