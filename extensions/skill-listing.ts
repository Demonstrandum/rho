import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// pi runs every skill name, description, and path through an xml escaper before
// putting them in the <available_skills> block (formatSkillsForPrompt, in
// dist/core/skills.js). the block is not parsed as xml by anything: the tags are
// there to group the listing, and the model reads the text. so a description
// that mentions "analyze logs" arrives as &quot;analyze logs&quot;, which spends
// tokens and misspells the word the description was trying to give the model.
//
// the quote, apostrophe, and ampersand escapes are undone here. the angle
// brackets are left escaped, since an unescaped < in a description would look
// like a tag boundary in the block that surrounds it.
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
    [/&quot;/g, '"'],
    [/&apos;/g, "'"],
    [/&#39;/g, "'"],
    // last, so that an escaped entity such as &amp;quot; survives as &quot;
    [/&amp;/g, '&'],
];

const BLOCK = /<available_skills>[\s\S]*?<\/available_skills>/;

export const unescapeSkillBlock = (systemPrompt: string): string =>
    systemPrompt.replace(BLOCK, (block) =>
        ENTITIES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), block),
    );

export default function (pi: ExtensionAPI) {
    pi.on('before_agent_start', async (event) => {
        const systemPrompt = unescapeSkillBlock(event.systemPrompt);
        if (systemPrompt === event.systemPrompt) return;
        return { systemPrompt };
    });
}
