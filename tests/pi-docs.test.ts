import { test, expect } from 'bun:test';
import {
    buildIndex,
    findPiRoot,
    hitTitle,
    parseBuiltinCommands,
    parseDocSections,
    queryTerms,
    search,
    type SearchRecord,
} from '../extensions/lib/pi-docs';

const BUILTIN_SOURCE = `
export const slashCommands = [
    { name: "tree", description: "Navigate session tree (switch branches)" },
    { name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
    { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
    { name: "import", description: "Import and resume a session from a JSONL file" },
];
`;

test('built-in commands parse out of the shipped array literal', () => {
    const cmds = parseBuiltinCommands(BUILTIN_SOURCE);
    console.log('parsed:', cmds.map((c) => c.name).join(', '));
    expect(cmds.map((c) => c.name)).toEqual(['tree', 'thinking', 'export', 'import']);
    expect(cmds[1].argumentHint).toBe('<level>');
    expect(cmds[3].description).toBe('Import and resume a session from a JSONL file');
});

test('a renamed or restructured file yields no commands rather than throwing', () => {
    expect(parseBuiltinCommands('export const x = 1;')).toEqual([]);
    expect(parseBuiltinCommands('')).toEqual([]);
});

const DOC = `# Sessions

Intro line.

## Session Storage

Sessions auto-save to \`~/.pi/agent/sessions/\`.

\`\`\`bash
# not a heading
pi -c
\`\`\`

## Naming Sessions

Use /name.
`;

test('doc sections split at headings and ignore headings inside code fences', () => {
    const secs = parseDocSections(DOC, '/abs/sessions.md', 'docs/sessions.md');
    console.log('headings:', secs.map((s) => s.heading).join(' | '));
    expect(secs.map((s) => s.heading)).toEqual([
        'Sessions',
        'Sessions > Session Storage',
        'Sessions > Naming Sessions',
    ]);
    expect(secs[1].body).toContain('# not a heading');
    expect(secs[2].line).toBe(14);
});

test('stopwords are dropped, but a query of only stopwords still searches', () => {
    expect(queryTerms('move a session to another machine')).toEqual(['move', 'session', 'another', 'machine']);
    expect(queryTerms('how do i')).toEqual(['how', 'do']);
});

const RECORDS: SearchRecord[] = [
    ...parseBuiltinCommands(BUILTIN_SOURCE),
    {
        kind: 'command',
        name: 'share',
        description: 'Share session as a secret GitHub gist',
        argumentHint: null,
        origin: 'builtin',
        source: null,
    },
    ...parseDocSections(DOC, '/abs/sessions.md', 'docs/sessions.md'),
    {
        kind: 'doc',
        file: '/abs/extensions.md',
        display: 'docs/extensions.md',
        heading: 'Extensions > pi.registerProvider',
        line: 100,
        body: 'Register or override a model provider. Previously registered providers are replaced.',
    },
];

test('a word inside a description finds the command', () => {
    const hits = search(RECORDS, 'jsonl', { limit: 3 });
    console.log(hits.map((h) => `${hitTitle(h)} ${h.score.toFixed(1)}`).join(' | '));
    expect(hits.slice(0, 2).map(hitTitle).sort()).toEqual(['/export', '/import']);
});

test('a substring inside a longer word loses to a whole-word match', () => {
    // "gist" is inside "register"; /share is what the reader wants.
    const hits = search(RECORDS, 'gist', { limit: 3 });
    console.log(hits.map((h) => `${hitTitle(h)} ${h.score.toFixed(1)}`).join(' | '));
    expect(hitTitle(hits[0])).toBe('/share');
});

test('a misspelled command name still resolves through subsequence matching', () => {
    const hits = search(RECORDS, 'expot', { limit: 2 });
    expect(hitTitle(hits[0])).toBe('/export');
});

test('kind restricts the result set', () => {
    const docs = search(RECORDS, 'session', { kind: 'doc', limit: 10 });
    expect(docs.every((h) => h.record.kind === 'doc')).toBe(true);
    const cmds = search(RECORDS, 'session', { kind: 'command', limit: 10 });
    expect(cmds.every((h) => h.record.kind === 'command')).toBe(true);
});

test('an empty query returns nothing', () => {
    expect(search(RECORDS, '   ')).toEqual([]);
});

// the two integration checks below pin what a pi release could silently break:
// the location of the built-in command array, and the docs directory.
test('the installed pi is locatable and still ships both sources', () => {
    const root = findPiRoot();
    console.log('pi root:', root);
    expect(root).not.toBeNull();

    const report = buildIndex({ piRoot: root });
    console.log(`builtins ${report.builtinsFound}, doc files ${report.docFiles}, records ${report.records.length}`);
    expect(report.builtinsFound).toBeGreaterThan(10);
    expect(report.docFiles).toBeGreaterThan(10);
});

test('/import is findable from the word a person remembers', () => {
    const report = buildIndex();
    const names = search(report.records, 'import session jsonl', { kind: 'command', limit: 3 }).map(hitTitle);
    console.log('hits:', names.join(', '));
    expect(names).toContain('/import');
});
