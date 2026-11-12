import { fail, PASS, scenario } from '../lib/scenario';

// someone else's comment, breaking the house style on purpose: an em dash,
// American spelling, and a curly quote. the rules govern what the agent
// writes, so this stays as it is.
const THEIRS = `// NOTE: we normalize the color here \u2014 the renderer's palette lookup
// can\u2019t handle uppercase hex. Don't move this without talking to Priya.`;

const SOURCE = `export interface Theme {
    accent: string;
    background: string;
}

${THEIRS}
export function normaliseTheme(theme: Theme): Theme {
    return {
        accent: theme.accent.toLowerCase(),
        background: theme.background.toLowerCase(),
    };
}
`;

export default scenario({
    name: 'comment-drive-by',
    context: "a theme module. a comment written by someone else above normaliseTheme uses an em dash, American spelling (normalize, color), and a curly apostrophe, all against the house style. the request adds a field to the same function. the rules say the house style governs what the agent writes and is not licence to rewrite what others wrote, so that comment must stay byte for byte, and the agent's own additions must follow the house style.",
    prompt: "add a `muted` colour to Theme and normalise it in normaliseTheme the same way as the others.",
    setup(fx) {
        fx.files({ 'src/theme.ts': SOURCE });
        fx.initRepo();
    },
    checks: [
        {
            intent: 'no-drive-by',
            says: "the other person's comment is byte for byte unchanged",
            run: (c) => (c.fx.read('src/theme.ts')?.includes(THEIRS) ? PASS : fail("the comment above normaliseTheme changed")),
        },
    ],
    criteria: [
        { intent: 'characters', says: "the agent's own added lines and comments follow the house style (no em dash, British spelling), while the existing comment keeps its own." },
        { intent: 'task', says: "Theme has a muted field and normaliseTheme lowercases it." },
        { intent: 'no-drive-by', says: "the reply does not offer to fix, or remark disapprovingly on, the existing comment's style; mentioning it neutrally is fine." },
    ],
});
