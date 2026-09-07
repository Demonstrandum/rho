import { describe, expect, test } from 'bun:test';
import { unescapeSkillBlock } from '../extensions/skill-listing';

const block = (description: string): string =>
    `before\n<available_skills>\n  <skill>\n    <name>x</name>\n    <description>${description}</description>\n    <location>/tmp/SKILL.md</location>\n  </skill>\n</available_skills>\nafter`;

describe('unescapeSkillBlock', () => {
    test('undoes quote and apostrophe escapes', () => {
        expect(unescapeSkillBlock(block('Triggers: &quot;analyze logs&quot;, the user&apos;s files')))
            .toContain('Triggers: "analyze logs", the user\'s files');
    });

    test('undoes a numeric apostrophe entity', () => {
        expect(unescapeSkillBlock(block('the user&#39;s files'))).toContain("the user's files");
    });

    test('leaves angle brackets escaped', () => {
        const out = unescapeSkillBlock(block('use &lt;tag&gt; here'));
        expect(out).toContain('&lt;tag&gt;');
    });

    test('an escaped entity survives as an entity', () => {
        expect(unescapeSkillBlock(block('literal &amp;quot; in the text'))).toContain('literal &quot; in the text');
    });

    test('text outside the block is untouched', () => {
        const out = unescapeSkillBlock(`&quot;keep&quot;\n${block('&quot;fix&quot;')}`);
        expect(out.startsWith('&quot;keep&quot;')).toBe(true);
        expect(out).toContain('<description>"fix"</description>');
    });

    test('a prompt with no skill block is returned unchanged', () => {
        const source = 'no skills here &quot;at all&quot;';
        expect(unescapeSkillBlock(source)).toBe(source);
    });
});
