import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { formatFinding, parseFindings, proseOf, resolveReviewer } from '../extensions/lib/audit';

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

test('the stated valid-rule set matches the actual Checks headings', () => {
    // the intro sentence names every citable rule so a reviewer model cannot
    // reach for a plausible-looking neighbor (7.(i) beside 7.(vii)); if a
    // check is ever added or removed from the list below without updating
    // that sentence, the two sets diverge silently unless this catches it.
    const content = readFileSync(skillPath, 'utf8');
    const headings = new Set(content.match(/^\d+\.\([ivx]+\)/gm));

    const introMatch = content.match(/may cite are:([\s\S]*?)\. Any other number/);
    expect(introMatch).not.toBeNull();
    const stated = new Set(
        introMatch![1]
            .split(',')
            .map((s) => s.trim().replace(/\.$/, ''))
            .filter(Boolean),
    );

    expect(stated).toEqual(headings);
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

const haiku = { provider: 'anthropic', id: 'claude-haiku-4-5' } as Model<Api>;
const session = { provider: 'anthropic', id: 'claude-sonnet-4-5' } as Model<Api>;
const registry = {
    find: (provider: string, id: string) =>
        provider === haiku.provider && id === haiku.id ? haiku : undefined,
};

test('a reviewer spec names a provider and a model', () => {
    const resolved = resolveReviewer('anthropic/claude-haiku-4-5', session, registry);
    expect(resolved).toEqual({ ok: true, model: haiku });
});

test('an id containing a slash keeps it, because the split is at the first one', () => {
    const seen: string[] = [];
    resolveReviewer('openrouter/anthropic/claude-haiku-4.5', undefined, {
        find: (provider, id) => {
            seen.push(provider, id);
            return undefined;
        },
    });
    expect(seen).toEqual(['openrouter', 'anthropic/claude-haiku-4.5']);
});

test('"current" is the session model, and fails when there is none', () => {
    expect(resolveReviewer('current', session, registry)).toEqual({ ok: true, model: session });
    const none = resolveReviewer('current', undefined, registry);
    expect(none.ok).toBe(false);
});

test('a spec that is not provider/id is reported rather than guessed at', () => {
    for (const spec of ['haiku', '/claude-haiku-4-5', 'anthropic/']) {
        const resolved = resolveReviewer(spec, session, registry);
        expect(resolved.ok).toBe(false);
    }
});

test('an unavailable model is reported by name', () => {
    const resolved = resolveReviewer('anthropic/claude-opus-9', session, registry);
    expect(resolved).toEqual({ ok: false, message: 'reviewer model anthropic/claude-opus-9 is unavailable' });
});

test('only text blocks reach the reviewer', () => {
    const prose = proseOf([
        { type: 'thinking', thinking: 'not for the reviewer', thinkingSignature: '' },
        { type: 'text', text: 'first block' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
        { type: 'text', text: 'second block' },
    ]);
    expect(prose).toBe('first block\n\nsecond block');
});

test('a message with no prose yields nothing to review', () => {
    expect(proseOf([{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }])).toBe('');
    expect(proseOf('   ')).toBe('');
});

const draftFinding = {
    location: 'the closing sentence',
    token: 'crucial',
    rule: '6.(iii)',
    prerequisite: 'The reader cannot tell what fails without it.',
    repair: 'Cut the word.',
};

test('a citation outside the Checks list is dropped rather than surfaced', () => {
    // 7.(i), passive voice, is deliberately writer-only (see SKILL.md); a
    // model reaching for it anyway must not have that citation reach the user.
    const findings = parseFindings({
        findings: [draftFinding, { ...draftFinding, rule: '7.(i)' }],
    });
    expect(findings).toEqual([draftFinding]);
});

test('malformed tool arguments are rejected outright, not partially accepted', () => {
    expect(parseFindings({ findings: 'not an array' })).toBeUndefined();
    expect(parseFindings({ findings: [{ location: 'x' }] })).toBeUndefined();
    expect(parseFindings('not an object')).toBeUndefined();
});

test('a finding formats to one line keyed to location, token, and rule', () => {
    const line = formatFinding({
        location: 'the closing sentence',
        token: 'crucial',
        rule: '6.(iii)',
        prerequisite: 'The reader cannot tell what fails without it.',
        repair: 'Cut the word.',
    });
    expect(line).toBe(
        'the closing sentence, "crucial": 6.(iii). The reader cannot tell what fails without it. Cut the word.',
    );
});
