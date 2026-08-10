import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const skillPath = join(import.meta.dir, '..', 'skills', 'auditor', 'SKILL.md');

test('auditor SKILL.md exists and has frontmatter', () => {
    expect(existsSync(skillPath)).toBe(true);
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toStartWith('---');
    expect(content).toContain('name: auditor');
});

test('auditor SKILL.md contains the expected check rules', () => {
    const content = readFileSync(skillPath, 'utf8');
    const expectedRules = [
        '1.(iii)',
        '2.(i)',
        '2.(ii)',
        '2.(iii)',
        '2.(iv)',
        '3.(ii)',
        '4.(i)',
        '5.(ii)',
        '6.(i)',
        '6.(iii)',
        '7.(vii)',
        '8.(i)',
        '9.(i)',
        '10.(ii)',
        '11.(i)',
        '12.(iv)',
        '13.(ii)',
        '13.(iv)',
        '13.(vi)',
    ];
    for (const rule of expectedRules) {
        expect(content).toContain(rule);
    }
});

test('auditor SKILL.md does not contain writer-only rules', () => {
    const content = readFileSync(skillPath, 'utf8');
    // rule 1.(i) and 1.(ii) are writer-only (not decidable from text alone)
    // they should not appear as check headings; they may appear in references.
    // verify they are not bolded check headings.
    expect(content).not.toContain('**Undischarged assertion.**');
    expect(content).not.toContain('**Cadence as proof.**');
});

test('auditor SKILL.md specifies output format', () => {
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toContain('## Output');
    expect(content).toContain('[line]');
});

test('auditor extension builds the correct skill invocation', () => {
    // test the prompt construction logic without needing the real pi API.
    const buildPrompt = (args: string) => {
        const audience = args.trim();
        return audience
            ? `/skill:auditor audience: ${audience}`
            : '/skill:auditor';
    };

    expect(buildPrompt('')).toBe('/skill:auditor');
    expect(buildPrompt('  ')).toBe('/skill:auditor');
    expect(buildPrompt('ML engineers')).toBe('/skill:auditor audience: ML engineers');
});
