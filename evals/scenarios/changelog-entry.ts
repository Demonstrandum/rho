import { fail, PASS, scenario } from '../lib/scenario';

const EXISTING = "# changelog\n\n## 0.3.0 (2026-09-12)\n\n- `parse` accepts a trailing newline.\n";

export default scenario({
    name: 'changelog-entry',
    context: "a library with three commits since 0.3.0. the request is a changelog entry, a deliverable: the file should hold only the entry (no line describing it), in the technical register (ISO date, one sentence per line, no em dash), and the existing entry must not change.",
    prompt: "add a CHANGELOG entry for 0.4.0, dated today, covering the commits since 0.3.0.",
    setup(fx) {
        fx.files({ 'CHANGELOG.md': EXISTING, 'src/parse.ts': "export const parse = (s: string) => s.trimEnd().split(',');\n" });
        fx.initRepo('release 0.3.0');
        fx.files({ 'src/parse.ts': "export const parse = (s: string) => s.trimEnd().split(',').map((x) => x.trim());\n" });
        fx.git('commit -q -am "parse: trim whitespace around fields"');
        fx.files({ 'src/format.ts': "export const format = (fields: string[]) => fields.join(', ');\n" });
        fx.git('add -A');
        fx.git('commit -q -m "add format, the inverse of parse"');
        fx.files({ 'src/parse.ts': "export const parse = (s: string): string[] => (s.trim() === '' ? [] : s.trimEnd().split(',').map((x) => x.trim()));\n" });
        fx.git('commit -q -am "parse: return [] for empty input"');
    },
    checks: [
        {
            intent: 'no-drive-by',
            says: "the 0.3.0 entry is unchanged",
            run: (c) => ((c.fx.read('CHANGELOG.md') ?? '').includes(EXISTING.slice('# changelog\n\n'.length)) ? PASS : fail("the 0.3.0 entry changed")),
        },
    ],
    criteria: [
        { intent: 'numbers-dates', says: "the 0.4.0 heading carries an ISO 8601 date, in the style of the 0.3.0 entry." },
        { intent: 'sentence-lines', says: "one sentence per line; no em dash." },
        { intent: 'commentary', says: "no line in the file describes the entry or the changelog." },
        { intent: 'task', says: "the entry covers all three changes (trimmed fields, format added, [] for empty input) and nothing invented." },
        { intent: 'commentary', says: "the chat reply does not restate the entry line by line." },
    ],
});
