import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PromptLoader } from '../extensions/lib/prompt-loader';

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
        '## 1. Assertions',
        '## 2. Terms',
        '## 3. Compression',
        '## 4. Presupposition',
        '## 5. Figures',
        '## 6. Vocabulary',
        '## 7. Sentences',
        '## 8. Rhetoric',
        '## 9. Endings',
        '## 10. Register',
        '## 11. Commentary',
        '## 12. Formatting',
        '## 13. Failure and correction',
    ];
    for (const section of expectedSections) {
        expect(content).toContain(section);
    }
});

test('writer-rules.md references the auditor and the filter', () => {
    const content = readFileSync(rulesPath, 'utf8');
    expect(content).toContain('## Audit');
    expect(content).toContain('## Filter');
});

test('PromptLoader resolves includes from the master template', () => {
    const loader = new PromptLoader(systemDir);
    const result = loader.resolve({ WORDS: '  - test -> test', PATTERNS: '' });
    expect(result).toContain('# personal rules');
    expect(result).toContain('# technical prose');
    expect(result).toContain('## vocabulary');
    expect(result).toContain('  - test -> test');
});

test('PromptLoader caches the resolved result', () => {
    const loader = new PromptLoader(systemDir);
    const first = loader.resolve({ WORDS: '  - a -> b', PATTERNS: '' });
    const second = loader.resolve({ WORDS: '  - x -> y', PATTERNS: '' });
    expect(first).toBe(second);
});

test('PromptLoader collapses triple blank lines', () => {
    const loader = new PromptLoader(systemDir);
    const result = loader.resolve({ WORDS: '  - a -> b', PATTERNS: '' });
    expect(result).not.toMatch(/\n{3,}/);
});
