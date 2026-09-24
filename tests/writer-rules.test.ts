import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PromptLoader } from '../extensions/lib/prose/prompt-loader';

const systemDir = join(import.meta.dir, '..', 'system');
const rulesPath = join(systemDir, 'writer-rules.md');

test('writer-rules.md exists and is non-empty', () => {
    expect(existsSync(rulesPath)).toBe(true);
    const content = readFileSync(rulesPath, 'utf8').trim();
    expect(content.length).toBeGreaterThan(0);
});

test('writer-rules.md contains the expected rule sections', () => {
    const content = readFileSync(rulesPath, 'utf8');
    const expectedSections = [
        '## 1. assertions',
        '## 2. terms',
        '## 3. compression',
        '## 4. presupposition',
        '## 5. figures',
        '## 6. vocabulary',
        '## 7. sentences',
        '## 8. rhetoric',
        '## 9. endings',
        '## 10. register',
        '## 11. commentary',
        '## 12. formatting',
        '## 13. failure and correction',
    ];
    for (const section of expectedSections) {
        expect(content).toContain(section);
    }
});

test('writer-rules.md references the auditor and the filter', () => {
    const content = readFileSync(rulesPath, 'utf8');
    expect(content).toContain('## audit');
    expect(content).toContain('## filter');
});

test('PromptLoader resolves includes and evaluates expressions', () => {
    const loader = new PromptLoader(systemDir);
    const words: [string, string[]][] = [['test-key', ['test-val']]];
    const result = loader.resolve({ words, patterns: [] });
    expect(result).toContain('# personal rules');
    expect(result).toContain('# technical prose');
    expect(result).toContain('## vocabulary');
    expect(result).toContain('"test-key" -> "test-val"');
});

test('PromptLoader caches the resolved result', () => {
    const loader = new PromptLoader(systemDir);
    const first = loader.resolve({ words: [['a', ['b']]], patterns: [] });
    const second = loader.resolve({ words: [['x', ['y']]], patterns: [] });
    expect(first).toBe(second);
});

test('PromptLoader collapses triple blank lines', () => {
    const loader = new PromptLoader(systemDir);
    const result = loader.resolve({ words: [['a', ['b']]], patterns: [] });
    expect(result).not.toMatch(/\n{3,}/);
});
