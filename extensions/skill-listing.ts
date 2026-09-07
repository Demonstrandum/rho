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
//
// the indentation goes too. pi indents <skill> by two spaces and its children by
// four, but a description carrying its own newlines (any skill whose frontmatter
// wrote one, which is most of them) puts its later lines at column zero, so the
// listing is ragged rather than nested. the tags already show the nesting, so the
// leading spaces buy nothing and cost a token per line. the description text is
// trimmed at the same time, which brings its closing tag back onto its own last
// line instead of a line of its own.
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
    [/&quot;/g, '"'],
    [/&apos;/g, "'"],
    [/&#39;/g, "'"],
    // last, so that an escaped entity such as &amp;quot; survives as &quot;
    [/&amp;/g, '&'],
];

const BLOCK = /<available_skills>[\s\S]*?<\/available_skills>/;
const INDENTED_TAG = /^[ \t]+(?=<)/gm;
const DESCRIPTION = /<description>([\s\S]*?)<\/description>/g;

export const unescapeSkillBlock = (systemPrompt: string): string =>
    systemPrompt.replace(BLOCK, (block) => {
        const unescaped = ENTITIES.reduce(
            (text, [pattern, replacement]) => text.replace(pattern, replacement),
            block,
        );
        return unescaped
            .replace(DESCRIPTION, (_, body: string) => `<description>${body.trim()}</description>`)
            .replace(INDENTED_TAG, '');
    });

export default function (pi: ExtensionAPI) {
    pi.on('before_agent_start', async (event) => {
        const systemPrompt = unescapeSkillBlock(event.systemPrompt);
        if (systemPrompt === event.systemPrompt) return;
        return { systemPrompt };
    });
}
