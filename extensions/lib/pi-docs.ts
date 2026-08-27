// a searchable index over pi's own commands and documentation.
//
// pi has no way to search either. the `/` completion fuzzy-matches command
// NAMES only (pi-tui's CombinedAutocompleteProvider filters with
// `fuzzyFilter(items, prefix, (item) => item.name)`, and attaches the
// description afterwards, for display), and nothing at all exposes the command
// list or the docs to the agent. so `/export` is unfindable from the word
// "jsonl", which is the only word a person remembers.
//
// three sources go into one index:
//
//   - built-in commands, parsed out of <pi>/dist/core/slash-commands.js. that
//     array is not re-exported from the package index, and the `exports` map in
//     package.json has only ".", "./rpc-entry" and "./client", so a deep import
//     does not resolve. reading the file is what is left. a release that
//     renames it degrades to zero built-ins rather than throwing, and the
//     caller can report that (see `IndexReport.builtinsFound`).
//   - session commands from pi.getCommands(): extension commands, prompt
//     templates, and skills, with their provenance. built-in interactive
//     commands are documented as excluded from that call, which is why the
//     first source exists.
//   - markdown sections from <pi>/README.md and <pi>/docs/*.md, split at
//     headings, so a query matches the prose that explains a command as well as
//     the one-clause description beside its name.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';

export type CommandOrigin = 'builtin' | 'extension' | 'prompt' | 'skill';

export interface CommandRecord {
    readonly kind: 'command';
    /** invocable name without the leading slash */
    readonly name: string;
    readonly description: string;
    readonly argumentHint: string | null;
    readonly origin: CommandOrigin;
    /** package or file the command came from; null for built-ins */
    readonly source: string | null;
}

export interface DocRecord {
    readonly kind: 'doc';
    readonly file: string;
    /** path as shown to the reader, relative to the root it was found under */
    readonly display: string;
    /** heading path, e.g. "Sessions > Session Storage" */
    readonly heading: string;
    /** 1-based line of the heading */
    readonly line: number;
    readonly body: string;
}

export type SearchRecord = CommandRecord | DocRecord;

export interface Hit {
    readonly record: SearchRecord;
    readonly score: number;
    readonly snippet: string;
    /** how many query terms the record matched */
    readonly matched: number;
}

/** what an index build found, so a caller can report a degraded source. */
export interface IndexReport {
    readonly piRoot: string | null;
    readonly builtinsFound: number;
    readonly docFiles: number;
    readonly records: readonly SearchRecord[];
}

const SCOPE = '@earendil-works';
const PACKAGE = 'pi-coding-agent';
const BUILTIN_FILE = join('dist', 'core', 'slash-commands.js');
const MAX_DOC_DEPTH = 4;

// ---------------------------------------------------------------- locating pi

/** the directory holding the running pi's package, or null. */
export function findPiRoot(): string | null {
    return fromRequire() ?? fromPath();
}

function walkUpToPackage(start: string): string | null {
    let current = start;
    for (let depth = 0; depth < 12; depth += 1) {
        if (basename(current) === PACKAGE && basename(dirname(current)) === SCOPE) return current;
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
    }
    return null;
}

function fromRequire(): string | null {
    try {
        const entry = createRequire(import.meta.url).resolve(`${SCOPE}/${PACKAGE}`);
        return walkUpToPackage(dirname(entry));
    } catch {
        return null;
    }
}

/**
 * the pi on PATH, with node_modules/.bin stripped: `bun run` prepends it, and a
 * project-local devDependency copy would answer instead of the installed one.
 */
function fromPath(): string | null {
    try {
        const path = (process.env.PATH ?? '')
            .split(':')
            .filter((entry) => !entry.includes(join('node_modules', '.bin')))
            .join(':');
        const bin = execFileSync('sh', ['-c', 'command -v pi'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, PATH: path },
        }).trim();
        if (bin === '') return null;
        return walkUpToPackage(dirname(realpathSync(bin)));
    } catch {
        return null;
    }
}

// ------------------------------------------------------- built-in commands

function unquote(literal: string): string {
    return literal.replace(/\\(["'\\nrt])/g, (_m, c: string) => {
        if (c === 'n') return '\n';
        if (c === 'r') return '\r';
        if (c === 't') return '\t';
        return c;
    });
}

function stringField(block: string, key: string): string | null {
    const m = new RegExp(`${key}\\s*:\\s*(["'\`])((?:[^\\\\]|\\\\.)*?)\\1`).exec(block);
    return m ? unquote(m[2]) : null;
}

/** parse `{ name: "x", description: "y", argumentHint: "z" }` object literals. */
export function parseBuiltinCommands(source: string): CommandRecord[] {
    const out: CommandRecord[] = [];
    for (const m of source.matchAll(/\{[^{}]*\}/g)) {
        const block = m[0];
        const name = stringField(block, 'name');
        if (name === null || !/^[a-z][a-z0-9:-]*$/i.test(name)) continue;
        out.push({
            kind: 'command',
            name,
            description: stringField(block, 'description') ?? '',
            argumentHint: stringField(block, 'argumentHint'),
            origin: 'builtin',
            source: null,
        });
    }
    return out;
}

function readBuiltins(piRoot: string): CommandRecord[] {
    const file = join(piRoot, BUILTIN_FILE);
    if (!existsSync(file)) return [];
    try {
        return parseBuiltinCommands(readFileSync(file, 'utf8'));
    } catch {
        return [];
    }
}

// -------------------------------------------------------------- doc sections

/** split markdown into one record per heading, ignoring headings in code fences. */
export function parseDocSections(text: string, file: string, display: string): DocRecord[] {
    const lines = text.split('\n');
    const out: DocRecord[] = [];
    const stack: string[] = [];
    let fenced = false;
    let current: { heading: string; line: number; body: string[] } | null = null;

    const flush = (): void => {
        if (current === null) return;
        out.push({
            kind: 'doc',
            file,
            display,
            heading: current.heading,
            line: current.line,
            body: current.body.join('\n').trim(),
        });
        current = null;
    };

    lines.forEach((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        const m = fenced ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (m) {
            flush();
            const depth = m[1].length;
            stack.length = Math.min(stack.length, depth - 1);
            stack[depth - 1] = m[2].replace(/[`*]/g, '');
            current = {
                heading: stack.filter((s) => s !== undefined).join(' > '),
                line: i + 1,
                body: [],
            };
            return;
        }
        if (current === null) {
            current = { heading: display, line: 1, body: [] };
        }
        current.body.push(line);
    });
    flush();
    return out.filter((r) => r.body !== '' || r.heading !== '');
}

function markdownFiles(root: string, depth = 0): string[] {
    if (depth > MAX_DOC_DEPTH) return [];
    let entries: Dirent[];
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
        const full = join(root, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            out.push(...markdownFiles(full, depth + 1));
        } else if (entry.name.endsWith('.md')) {
            out.push(full);
        }
    }
    return out;
}

function readDocs(root: string, label: string): DocRecord[] {
    let files: string[];
    try {
        files = statSync(root).isDirectory() ? markdownFiles(root) : [root];
    } catch {
        return [];
    }
    const out: DocRecord[] = [];
    for (const file of files) {
        try {
            const rel = relative(dirname(root), file).split(sep).join('/');
            out.push(...parseDocSections(readFileSync(file, 'utf8'), file, `${label}${rel}`));
        } catch {
            // an unreadable file is skipped; the rest of the index still builds.
        }
    }
    return out;
}

// -------------------------------------------------------------------- index

export interface SessionCommand {
    readonly name: string;
    readonly description?: string;
    readonly source: 'extension' | 'prompt' | 'skill';
    readonly sourceInfo?: { readonly source?: string; readonly path?: string };
}

export interface BuildOptions {
    readonly piRoot?: string | null;
    /** pi.getCommands() output: extension commands, templates, skills */
    readonly sessionCommands?: readonly SessionCommand[];
    /** extra markdown files or directories to index */
    readonly extraDocRoots?: readonly string[];
}

export function buildIndex(options: BuildOptions = {}): IndexReport {
    const piRoot = options.piRoot === undefined ? findPiRoot() : options.piRoot;
    const records: SearchRecord[] = [];
    let builtins: CommandRecord[] = [];
    let docFiles = 0;

    if (piRoot !== null) {
        builtins = readBuiltins(piRoot);
        records.push(...builtins);
        const docs = [
            ...readDocs(join(piRoot, 'README.md'), ''),
            ...readDocs(join(piRoot, 'docs'), ''),
        ];
        docFiles = new Set(docs.map((d) => d.file)).size;
        records.push(...docs);
    }

    const known = new Set(builtins.map((c) => c.name));
    for (const cmd of options.sessionCommands ?? []) {
        if (known.has(cmd.name)) continue;
        records.push({
            kind: 'command',
            name: cmd.name,
            description: cmd.description ?? '',
            argumentHint: null,
            origin: cmd.source,
            source: cmd.sourceInfo?.source ?? cmd.sourceInfo?.path ?? null,
        });
    }

    for (const root of options.extraDocRoots ?? []) {
        const docs = readDocs(root, '');
        docFiles += new Set(docs.map((d) => d.file)).size;
        records.push(...docs);
    }

    return { piRoot, builtinsFound: builtins.length, docFiles, records };
}

// ------------------------------------------------------------------- search

const TERM_RE = /[a-z0-9_.:+-]+/g;

// function words carry no signal and would otherwise decide whether a record
// counts as matching the whole query.
const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
    'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'so', 'that',
    'the', 'their', 'them', 'then', 'there', 'this', 'to', 'was', 'what', 'when', 'where', 'which',
    'will', 'with', 'you', 'your',
]);

export function queryTerms(query: string): string[] {
    const all = (query.toLowerCase().match(TERM_RE) ?? []).filter((t) => t.length > 1);
    const kept = all.filter((t) => !STOPWORDS.has(t));
    // a query made only of function words still has to search for something.
    return kept.length > 0 ? kept : all;
}

interface Occurrences {
    /** matches with a non-alphanumeric character on both sides */
    readonly whole: number;
    /** matches inside a longer word: "gist" in "register" */
    readonly partial: number;
}

const WORD_CHAR = /[a-z0-9]/;

function occurrences(hay: string, term: string): Occurrences {
    let whole = 0;
    let partial = 0;
    let from = 0;
    for (;;) {
        const at = hay.indexOf(term, from);
        if (at === -1) return { whole, partial };
        const before = at === 0 ? '' : hay[at - 1];
        const after = hay[at + term.length] ?? '';
        if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) partial += 1;
        else whole += 1;
        from = at + term.length;
    }
}

/** every character of `term` appears in `hay`, in order. */
function subsequence(term: string, hay: string): boolean {
    let i = 0;
    for (const ch of hay) {
        if (ch === term[i]) i += 1;
        if (i === term.length) return true;
    }
    return term.length === 0;
}

interface Lowered {
    readonly primary: string;
    readonly secondary: string;
    readonly body: string;
}

// lowercasing every record for every term of every query is the whole cost of a
// search, so it is done once per record and kept.
const loweredCache = new WeakMap<object, Lowered>();

function lowered(record: SearchRecord): Lowered {
    const hit = loweredCache.get(record);
    if (hit !== undefined) return hit;
    const made: Lowered =
        record.kind === 'command'
            ? { primary: record.name.toLowerCase(), secondary: '', body: record.description.toLowerCase() }
            : {
                  primary: record.heading.toLowerCase(),
                  secondary: record.display.toLowerCase(),
                  body: record.body.toLowerCase(),
              };
    loweredCache.set(record, made);
    return made;
}

function scoreTerm(record: SearchRecord, term: string): number {
    const text = lowered(record);
    const body = occurrences(text.body, term);
    if (record.kind === 'command') {
        const name = text.primary;
        let score = 0;
        if (name === term) score += 24;
        else if (name.startsWith(term)) score += 16;
        else if (name.includes(term)) score += 10;
        else if (subsequence(term, name)) score += 4;
        score += 4 * Math.min(2, body.whole) + 1 * Math.min(2, body.partial);
        return score;
    }
    const heading = occurrences(text.primary, term);
    let score = 6 * Math.min(1, heading.whole) + 1.5 * Math.min(1, heading.partial);
    if (text.secondary.includes(term)) score += 3;
    score += 1.5 * Math.min(4, body.whole) + 0.3 * Math.min(4, body.partial);
    return score;
}

/**
 * inverse document frequency: a term in half the records says almost nothing
 * about which record is wanted, and a term in five records says almost
 * everything. without this, "move a session to another machine" ranks on
 * "session".
 */
function idfs(records: readonly SearchRecord[], terms: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const term of terms) {
        let df = 0;
        for (const record of records) {
            const text = lowered(record);
            if (
                text.primary.includes(term) ||
                text.secondary.includes(term) ||
                text.body.includes(term)
            ) {
                df += 1;
            }
        }
        out.set(term, Math.log(1 + records.length / (1 + df)));
    }
    return out;
}

function bestLine(record: DocRecord, terms: readonly string[]): string {
    let best = '';
    let bestHits = 0;
    for (const raw of record.body.split('\n')) {
        const line = raw.trim();
        if (line === '') continue;
        const lower = line.toLowerCase();
        const hits = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
        if (hits > bestHits) {
            best = line;
            bestHits = hits;
        }
    }
    if (best === '') best = record.body.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    return best.length > 200 ? `${best.slice(0, 199)}…` : best;
}

const COMMAND_BOOST = 1.3;

export interface SearchOptions {
    readonly limit?: number;
    readonly kind?: 'command' | 'doc' | 'all';
}

export function search(
    records: readonly SearchRecord[],
    query: string,
    options: SearchOptions = {},
): Hit[] {
    const terms = queryTerms(query);
    const limit = options.limit ?? 12;
    const kind = options.kind ?? 'all';
    if (terms.length === 0) return [];

    const weight = idfs(records, terms);
    const scored: Hit[] = [];
    for (const record of records) {
        if (kind !== 'all' && record.kind !== kind) continue;
        let total = 0;
        let matched = 0;
        for (const term of terms) {
            const s = scoreTerm(record, term);
            if (s > 0) {
                matched += 1;
                total += s * (weight.get(term) ?? 1);
            }
        }
        if (matched === 0) continue;
        scored.push({
            record,
            // a command is the answer to "which command does X"; the doc section
            // that mentions it is the follow-up. break near-ties that way.
            score: record.kind === 'command' ? total * COMMAND_BOOST : total,
            matched,
            snippet: record.kind === 'command' ? record.description : bestLine(record, terms),
        });
    }

    // records matching every term win outright; a partial match is only shown
    // when nothing matches the whole query.
    const full = scored.filter((h) => h.matched === terms.length);
    const pool = full.length > 0 ? full : scored;

    pool.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.record.kind !== b.record.kind) return a.record.kind === 'command' ? -1 : 1;
        const an = a.record.kind === 'command' ? a.record.name : a.record.heading;
        const bn = b.record.kind === 'command' ? b.record.name : b.record.heading;
        return an.localeCompare(bn);
    });
    return pool.slice(0, limit);
}

/** "/export <file>  (built-in)" or "docs/sessions.md:34  Sessions > Storage" */
export function hitTitle(hit: Hit): string {
    const r = hit.record;
    if (r.kind === 'command') {
        const hint = r.argumentHint === null ? '' : ` ${r.argumentHint}`;
        return `/${r.name}${hint}`;
    }
    return `${r.display}:${r.line}`;
}

export function hitOrigin(hit: Hit): string {
    const r = hit.record;
    if (r.kind === 'doc') return r.heading;
    if (r.origin === 'builtin') return 'built-in';
    return r.source === null ? r.origin : `${r.origin} · ${r.source}`;
}
