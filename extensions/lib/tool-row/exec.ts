// collapsed and expanded previews for context-mode's exec tools.
//
// pure: no pi imports. a renderer feeds it the tool name, the raw tool
// arguments, the result text, a width, and a theme, and gets back styled
// strings. the theme is an interface so the module stays runnable outside pi;
// pi's own theme object satisfies it, and PLAIN_THEME drops every escape.
//
// three pieces:
//   parseExecCall    unvalidated tool args -> a typed call, or null
//   parseExecResult  raw result text -> the code echo plus a typed outcome
//   collapse/expand  a call and an outcome -> lines to draw
//
// shortening is a ladder per part: every command carries its renderings from
// longest to shortest, and fitLadders degrades the widest part until the join
// fits the budget. one command keeping its arguments while its neighbour is
// down to a bare head is the result of that, not a special case.

export const EXEC_LANGUAGES = [
    'javascript', 'typescript', 'python', 'shell', 'ruby',
    'go', 'rust', 'php', 'perl', 'r', 'elixir', 'csharp',
] as const;

export type ExecLanguage = (typeof EXEC_LANGUAGES)[number];

function isExecLanguage(value: unknown): value is ExecLanguage {
    return typeof value === 'string' && (EXEC_LANGUAGES as readonly string[]).includes(value);
}

export const EXEC_TOOLS = ['ctx_execute', 'ctx_execute_file', 'ctx_batch_execute'] as const;

export type ExecToolName = (typeof EXEC_TOOLS)[number];

export function isExecTool(name: string): name is ExecToolName {
    return (EXEC_TOOLS as readonly string[]).includes(name);
}

export interface BatchCommand {
    label: string;
    command: string;
}

export type ExecCall =
    | { tool: 'ctx_execute'; language: ExecLanguage; code: string; cwd?: string; intent?: string; background?: boolean }
    | { tool: 'ctx_execute_file'; path: string; language: ExecLanguage; code: string; intent?: string }
    | { tool: 'ctx_batch_execute'; commands: BatchCommand[]; queries: string[]; concurrency?: number };

// args arrive mid-stream, so every field is optional until it is not.
export function parseExecCall(tool: string, args: unknown): ExecCall | null {
    if (!isExecTool(tool) || args === null || typeof args !== 'object') return null;
    const a = args as Record<string, unknown>;
    const language = isExecLanguage(a.language) ? a.language : 'shell';
    const code = typeof a.code === 'string' ? a.code : '';
    switch (tool) {
        case 'ctx_execute':
            return {
                tool,
                language,
                code,
                cwd: typeof a.cwd === 'string' ? a.cwd : undefined,
                intent: typeof a.intent === 'string' ? a.intent : undefined,
                background: a.background === true,
            };
        case 'ctx_execute_file':
            return {
                tool,
                path: typeof a.path === 'string' ? a.path : '',
                language,
                code,
                intent: typeof a.intent === 'string' ? a.intent : undefined,
            };
        case 'ctx_batch_execute': {
            const commands = Array.isArray(a.commands)
                ? a.commands.flatMap((entry): BatchCommand[] => {
                    if (entry === null || typeof entry !== 'object') return [];
                    const e = entry as Record<string, unknown>;
                    if (typeof e.command !== 'string') return [];
                    return [{ label: typeof e.label === 'string' ? e.label : '', command: e.command }];
                })
                : [];
            const queries = Array.isArray(a.queries) ? a.queries.filter((q): q is string => typeof q === 'string') : [];
            return { tool, commands, queries, concurrency: typeof a.concurrency === 'number' ? a.concurrency : undefined };
        }
    }
}

export type ExecOutcome =
    | { kind: 'empty' }
    | { kind: 'ok'; stdout: string }
    | { kind: 'exit'; code: number; stdout: string; stderr: string }
    | { kind: 'timeout'; ms: number; stderr: string }
    | { kind: 'partial'; stdout: string; ms: number; state: 'backgrounded' | 'timed-out' }
    | { kind: 'indexed'; body: string };

export interface ExecEcho {
    language?: string;
    path?: string;
    code?: string;
}

export interface ParsedExecResult {
    echo?: ExecEcho;
    outcome: ExecOutcome;
}

const ECHO = /^(?:path=(?<path>[^\n]*)\n)?```(?<lang>[a-z]*)\n(?<code>[\s\S]*?)\n```\n*/;
const HARD_EXIT = /^Exit code: (\d+)\n\nstdout:\n([\s\S]*?)\n\nstderr:\n([\s\S]*)$/;
const TIMEOUT = /^Execution timed out after (\d+)ms\n\nstderr:\n?([\s\S]*)$/;
const BACKGROUNDED = /\n*_\(process backgrounded after (\d+)ms \u2014 still running\)_\s*$/;
const TIMED_OUT_PARTIAL = /\n*_\(timed out after (\d+)ms \u2014 partial output shown above\)_\s*$/;
const INDEXED = /^Indexed \d+ sections\b/;

export function parseExecResult(text: string): ParsedExecResult {
    const match = ECHO.exec(text);
    const echo: ExecEcho | undefined = match?.groups
        ? {
            language: match.groups.lang || undefined,
            path: match.groups.path || undefined,
            code: match.groups.code,
        }
        : undefined;
    const body = match ? text.slice(match[0].length) : text;
    return { echo, outcome: parseExecBody(body) };
}

export function parseExecBody(body: string): ExecOutcome {
    const trimmed = body.trim();
    if (trimmed === '' || trimmed === '(no output)') return { kind: 'empty' };

    const hard = HARD_EXIT.exec(trimmed);
    if (hard) {
        return { kind: 'exit', code: Number(hard[1]), stdout: hard[2].trim(), stderr: hard[3].trim() };
    }
    const timeout = TIMEOUT.exec(trimmed);
    if (timeout) {
        return { kind: 'timeout', ms: Number(timeout[1]), stderr: timeout[2].trim() };
    }
    const backgrounded = BACKGROUNDED.exec(trimmed);
    if (backgrounded) {
        return {
            kind: 'partial',
            stdout: trimmed.slice(0, backgrounded.index).trim(),
            ms: Number(backgrounded[1]),
            state: 'backgrounded',
        };
    }
    const partial = TIMED_OUT_PARTIAL.exec(trimmed);
    if (partial) {
        return {
            kind: 'partial',
            stdout: trimmed.slice(0, partial.index).trim(),
            ms: Number(partial[1]),
            state: 'timed-out',
        };
    }
    if (INDEXED.test(trimmed)) return { kind: 'indexed', body: trimmed };
    return { kind: 'ok', stdout: trimmed };
}

// a part's renderings, longest first. never empty.
export type Ladder = readonly [string, ...string[]];

const ELLIPSIS = '\u2026';
const BRACKET = `[${ELLIPSIS}]`;
// joins a full, untruncated set of lines: nothing was dropped, so the glyph
// says "next line" rather than "something is missing".
const RETURN = '⮐';

function rung(ladder: Ladder, level: number): string {
    return ladder[Math.min(level, ladder.length - 1)] ?? ladder[0];
}

function widthOf(parts: readonly string[], sep: string): number {
    if (parts.length === 0) return 0;
    return parts.reduce((n, p) => n + p.length, 0) + sep.length * (parts.length - 1);
}

function dedupeAdjacent(parts: readonly string[]): string[] {
    return parts.filter((part, i) => i === 0 || part !== parts[i - 1]);
}

export interface FitResult {
    text: string;
    /** every ladder rendered at its longest rung and no part was dropped. */
    exact: boolean;
}

/**
 * pick a rung per ladder so the joined parts fit `budget`. each step degrades
 * the currently widest part that has a shorter rung left, so width is taken
 * from wherever there is most of it.
 */
export function fitLaddersDetailed(ladders: readonly Ladder[], budget: number, sep = '; '): FitResult {
    if (ladders.length === 0) return { text: '', exact: true };
    const levels = ladders.map(() => 0);
    const current = () => ladders.map((l, i) => rung(l, levels[i]!));

    while (widthOf(current(), sep) > budget) {
        let pick = -1;
        let widest = -1;
        ladders.forEach((ladder, i) => {
            if (levels[i]! >= ladder.length - 1) return;
            const w = rung(ladder, levels[i]!).length;
            if (w > widest) {
                widest = w;
                pick = i;
            }
        });
        if (pick < 0) break;
        levels[pick]! += 1;
    }
    const exact = levels.every((l) => l === 0);

    const parts = dedupeAdjacent(current());
    if (widthOf(parts, sep) <= budget) {
        return { text: parts.join(sep), exact: exact && parts.length === ladders.length };
    }

    // every ladder is at its shortest and it still does not fit: drop parts.
    for (let keep = parts.length - 1; keep >= 1; keep--) {
        const dropped = parts.length - keep;
        const tail = ` +${dropped}`;
        if (widthOf(parts.slice(0, keep), sep) + tail.length <= budget) {
            return { text: parts.slice(0, keep).join(sep) + tail, exact: false };
        }
    }
    return { text: truncateEnd(parts[0]!, budget), exact: false };
}

export function fitLadders(ladders: readonly Ladder[], budget: number, sep = '; '): string {
    return fitLaddersDetailed(ladders, budget, sep).text;
}

export function truncateEnd(text: string, budget: number): string {
    if (text.length <= budget) return text;
    if (budget <= 1) return ELLIPSIS;
    return text.slice(0, budget - 1) + ELLIPSIS;
}

const PATH_TOKEN = /^-{0,2}[\w.]*=?(\/[^\s]*|~\/[^\s]*)$/;
const TEMP_SCRIPT = /(?:\/[^\s:]+)+\/([\w.-]+)(?=:\d+)/g;

/**
 * keep the tail of a long path: /a/b/c/pi-coding-agent/dist -> [...]/pi-coding-agent/dist.
 * segments are taken from the end until they carry `minTail` characters, so a
 * generic last segment (dist, src, build) keeps its parent.
 */
export function elidePath(token: string, max = 20, minTail = 12): string {
    if (token.length <= max || !token.includes('/')) return token;
    const segments = token.split('/').filter((s) => s !== '');
    const tail: string[] = [];
    for (let i = segments.length - 1; i >= 0; i--) {
        tail.unshift(segments[i]!);
        if (tail.join('/').length >= minTail) break;
    }
    if (tail.length >= segments.length) return token;
    return `${BRACKET}/${tail.join('/')}`;
}

/** /var/folders/xx/.ctx-mode-A1/script.sh:3: -> script.sh:3: */
export function elideScriptPaths(text: string): string {
    return text.replace(TEMP_SCRIPT, '$1');
}

/**
 * split shell source into commands. newline, `;`, `&&`, `||` separate;
 * quotes and backslashes suppress separation. pipelines stay in one command.
 */
export function splitShell(code: string): string[] {
    const out: string[] = [];
    let buf = '';
    let quote: '"' | '\'' | null = null;
    const flush = () => {
        const cmd = buf.trim();
        if (cmd !== '' && !cmd.startsWith('#')) out.push(cmd);
        buf = '';
    };
    for (let i = 0; i < code.length; i++) {
        const ch = code[i]!;
        if (quote) {
            buf += ch;
            if (ch === '\\' && quote === '"') {
                buf += code[++i] ?? '';
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === '\'') {
            quote = ch;
            buf += ch;
            continue;
        }
        if (ch === '\\' && code[i + 1] === '\n') {
            i++;
            continue;
        }
        if (ch === '\n' || ch === ';') {
            flush();
            continue;
        }
        if ((ch === '&' || ch === '|') && code[i + 1] === ch) {
            i++;
            flush();
            continue;
        }
        buf += ch;
    }
    flush();
    return out;
}

const REDIRECT = /\s*(?:\d?>>?|\d?<|&>)\s*\S+/g;

/** stages of a pipeline, ignoring `|` inside quotes (rg patterns hold them). */
export function splitPipeline(command: string): string[] {
    const stages: string[] = [];
    let buf = '';
    let quote: '"' | '\'' | null = null;
    for (const ch of command) {
        if (quote) {
            buf += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === '\'') {
            quote = ch;
            buf += ch;
            continue;
        }
        if (ch === '|') {
            stages.push(buf);
            buf = '';
            continue;
        }
        buf += ch;
    }
    stages.push(buf);
    return stages;
}

/** split on unquoted whitespace, so a quoted pattern survives as one token. */
export function tokenize(command: string): string[] {
    const out: string[] = [];
    let buf = '';
    let quote: '"' | '\'' | null = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i]!;
        if (quote) {
            buf += ch;
            if (ch === '\\' && quote === '"') buf += command[++i] ?? '';
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === '\'') {
            quote = ch;
            buf += ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (buf !== '') out.push(buf);
            buf = '';
            continue;
        }
        buf += ch;
    }
    if (buf !== '') out.push(buf);
    return out;
}

/** longest to shortest renderings of one shell command. */
export function shellLadder(command: string): Ladder {
    const full = command.replace(/\s+/g, ' ').trim();
    const firstStage = splitPipeline(full)[0]!.trim();
    const bare = firstStage.replace(REDIRECT, '').trim();
    const tokens = tokenize(bare);
    const head = tokens[0] ?? full;
    const elided = tokens.map((t) => (PATH_TOKEN.test(t) ? elidePath(t) : t)).join(' ');
    const firstFlag = tokens.slice(1).find((t) => t.startsWith('-'));
    const clipped = firstFlag ? `${head} ${firstFlag} ${BRACKET}` : tokens.length > 1 ? `${head} ${BRACKET}` : head;

    const rungs = [full, bare, elided, clipped, head];
    return dedupeSequential(rungs) as Ladder;
}

/** longest to shortest renderings of a non-shell program. */
export function codeLadder(language: ExecLanguage, code: string): Ladder {
    const lines = code.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    const count = lines.length;
    const first = lines.find((l) => !isNoise(language, l)) ?? lines[0] ?? '';
    const flat = first.replace(/\s+/g, ' ');
    const tag = `${language} ${count} line${count === 1 ? '' : 's'}`;
    const rungs = [
        count > 1 ? `${flat} ${BRACKET} +${count - 1}` : flat,
        `${truncateEnd(flat, 40)} ${BRACKET}`,
        tag,
        language,
    ];
    return dedupeSequential(rungs) as Ladder;
}

const NOISE: Record<ExecLanguage, RegExp> = {
    javascript: /^(?:\/\/|import |(?:const|let|var) .*=\s*require\(|require\()/,
    typescript: /^(?:\/\/|import |(?:const|let|var) .*=\s*require\()/,
    python: /^(?:#|import |from \w+ import)/,
    shell: /^#/,
    ruby: /^(?:#|require )/,
    go: /^(?:\/\/|package |import )/,
    rust: /^(?:\/\/|use )/,
    php: /^(?:\/\/|<\?|#)/,
    perl: /^(?:#|use )/,
    r: /^(?:#|library\()/,
    elixir: /^#/,
    csharp: /^(?:\/\/|using )/,
};

function isNoise(language: ExecLanguage, line: string): boolean {
    return NOISE[language].test(line);
}

function dedupeSequential(rungs: readonly string[]): readonly [string, ...string[]] {
    const kept = rungs.filter((r, i) => r !== '' && r !== rungs[i - 1]);
    return (kept.length > 0 ? kept : ['?']) as [string, ...string[]];
}

export function callLadders(call: ExecCall): Ladder[] {
    switch (call.tool) {
        case 'ctx_execute':
        case 'ctx_execute_file':
            return call.language === 'shell'
                ? splitShell(call.code).map(shellLadder)
                : [codeLadder(call.language, call.code)];
        // a batch command carries a written label, which beats any clipping of
        // the command itself, so it is the top rung and the command is unused.
        case 'ctx_batch_execute':
            return call.commands.map((c) =>
                c.label === ''
                    ? shellLadder(c.command)
                    : ([c.label, truncateEnd(c.label, 16)] as Ladder),
            );
    }
}

/** the subset of pi's ThemeColor this module draws with. */
export type PreviewColor =
    | 'toolTitle' | 'toolOutput' | 'text' | 'muted' | 'dim'
    | 'accent' | 'error' | 'warning' | 'success';

export interface PreviewTheme {
    fg(color: PreviewColor, text: string): string;
    bold(text: string): string;
    /** one entry per line of `code`. */
    highlight(code: string, language: string): string[];
}

export const PLAIN_THEME: PreviewTheme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    highlight: (code) => code.split('\n'),
};

// highlight.js knows shells as bash; the rest of the languages carry their own
// name through.
const HIGHLIGHT_LANGUAGE: Record<ExecLanguage, string> = {
    javascript: 'javascript',
    typescript: 'typescript',
    python: 'python',
    shell: 'bash',
    ruby: 'ruby',
    go: 'go',
    rust: 'rust',
    php: 'php',
    perl: 'perl',
    r: 'r',
    elixir: 'elixir',
    csharp: 'csharp',
};

function highlightLine(theme: PreviewTheme, text: string, language: ExecLanguage): string {
    return theme.highlight(text, HIGHLIGHT_LANGUAGE[language])[0] ?? text;
}

function callLanguage(call: ExecCall): ExecLanguage {
    return call.tool === 'ctx_batch_execute' ? 'shell' : call.language;
}

export interface CollapsedPreview {
    /** the call line: verb, shortened source, status tag. */
    call: string;
    /** the output line, or undefined when there is nothing to show. */
    output?: string;
}

const VERB: Record<ExecToolName, string> = {
    ctx_execute: 'exec',
    ctx_execute_file: 'exec file',
    ctx_batch_execute: 'batch',
};

interface StatusTag {
    text: string;
    color: PreviewColor;
}

function statusTag(outcome: ExecOutcome | undefined): StatusTag | undefined {
    if (!outcome) return undefined;
    switch (outcome.kind) {
        // no "code:" label: the bubble is already the error colour, so the
        // number alone reads as the exit status.
        case 'exit': return { text: `[${outcome.code}]`, color: 'error' };
        case 'timeout': return { text: `[timeout ${outcome.ms}ms]`, color: 'error' };
        case 'partial': return outcome.state === 'backgrounded'
            ? { text: '[background]', color: 'warning' }
            : { text: `[partial ${outcome.ms}ms]`, color: 'warning' };
        case 'indexed': return { text: '[indexed]', color: 'accent' };
        case 'empty': return { text: '[no output]', color: 'dim' };
        case 'ok': return undefined;
    }
}

// ctx_batch_execute's success text ("Executed N commands (...). Indexed M
// sections. Searched K queries.") is not a captured stdout, it is the tool's
// own written result. it does not get the stdout/stderr treatment: no label,
// no dim.
function isBatchSummary(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
): outcome is { kind: 'ok'; stdout: string } {
    return call.tool === 'ctx_batch_execute' && outcome?.kind === 'ok';
}

// batch entries are labels, not source: no backticks (that notation means
// "this is a command"), no syntax highlighting, and joined with a bullet
// rather than "; ", since they are independent named items, not statements.
const LABEL_SEP = ` \u00b7 `;

// the call line never carries a status tag: pi renders the call slot (this
// function) and the result slot (outputDigest, below) as two independently
// invoked components, and only the result slot ever sees the parsed outcome.
// putting the tag on the output line also places it next to the label it
// qualifies, e.g. "[1] stderr: ...", instead of dangling after the command.
export function collapseCall(call: ExecCall, width: number, theme: PreviewTheme = PLAIN_THEME): string {
    const verb = VERB[call.tool];
    const budget = Math.max(8, width - verb.length - 3);
    const isBatch = call.tool === 'ctx_batch_execute';
    const source = fitLadders(callLadders(call), budget, isBatch ? LABEL_SEP : '; ');
    const rendered = isBatch
        ? theme.fg('text', source)
        : theme.fg('dim', '`') + highlightLine(theme, source, callLanguage(call)) + theme.fg('dim', '`');
    return theme.fg('toolTitle', theme.bold(verb)) + ' ' + rendered;
}

/** the result slot's collapsed line: status tag, if any, then the output digest. */
export function collapseResult(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
    width: number,
    theme: PreviewTheme = PLAIN_THEME,
): string | undefined {
    const tag = statusTag(outcome);
    const tagWidth = tag ? tag.text.length + 1 : 0;
    const digest = isBatchSummary(call, outcome)
        ? theme.fg('toolOutput', truncateEnd(outcome.stdout.replace(/\s+/g, ' ').trim(), Math.max(8, width - tagWidth)))
        : outputDigest(outcome, Math.max(8, width - tagWidth), theme);
    if (!tag) return digest;
    return digest ? `${theme.fg(tag.color, tag.text)} ${digest}` : theme.fg(tag.color, tag.text);
}

/** @deprecated demo/test convenience; the real renderer calls collapseCall and collapseResult separately, as pi does. */
export function collapse(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
    width: number,
    theme: PreviewTheme = PLAIN_THEME,
): CollapsedPreview {
    return { call: collapseCall(call, width, theme), output: collapseResult(call, outcome, width, theme) };
}

/** one line from the output: the stream that carries the failure, if any. */
export function outputDigest(
    outcome: ExecOutcome | undefined,
    width: number,
    theme: PreviewTheme = PLAIN_THEME,
): string | undefined {
    if (!outcome) return undefined;
    const picked = pickStream(outcome);
    if (!picked) return undefined;
    const { label, text } = picked;
    const lines = elideScriptPaths(text)
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter((l) => l !== '');
    if (lines.length === 0) return undefined;
    const prefix = `${label}: `;
    const sep = ` ${ELLIPSIS} `;
    const { text: joined, exact } = fitLaddersDetailed(
        lines.map((l) => [l, truncateEnd(l, 40)] as Ladder),
        Math.max(8, width - prefix.length),
        sep,
    );
    // nothing was truncated or dropped: the join is a plain line break, not an
    // elision, so it gets the return glyph instead of the ellipsis. the glyph
    // sits where the newline was, at the end of the preceding line, so there
    // is no leading space, only a trailing one before the next line starts.
    const displaySep = exact ? `${RETURN} ` : sep;
    const styled = joined
        .split(sep)
        .map((part) => theme.fg('toolOutput', part))
        .join(theme.fg('dim', displaySep));
    return theme.fg(label === 'stderr' ? 'error' : 'muted', prefix) + styled;
}

function pickStream(outcome: ExecOutcome): { label: 'stdout' | 'stderr'; text: string } | undefined {
    switch (outcome.kind) {
        case 'empty': return undefined;
        case 'ok': return { label: 'stdout', text: outcome.stdout };
        case 'exit': return outcome.stderr !== ''
            ? { label: 'stderr', text: outcome.stderr }
            : { label: 'stdout', text: outcome.stdout };
        case 'timeout': return { label: 'stderr', text: outcome.stderr };
        case 'partial': return { label: 'stdout', text: outcome.stdout };
        case 'indexed': return { label: 'stdout', text: outcome.body };
    }
}

/** the call slot's expanded lines: verb, path (execute_file), full command(s)/code. */
export function expandCall(call: ExecCall, theme: PreviewTheme = PLAIN_THEME): string[] {
    const language = callLanguage(call);
    const prompt = theme.fg('dim', '$ ');
    const lines: string[] = [theme.fg('toolTitle', theme.bold(VERB[call.tool]))];

    if (call.tool === 'ctx_execute_file') {
        lines.push('', theme.fg('muted', 'path=') + theme.fg('text', call.path));
    }
    lines.push('');
    if (call.tool === 'ctx_batch_execute') {
        for (const c of call.commands) {
            const label = c.label === '' ? '' : theme.fg('dim', `   # ${c.label}`);
            lines.push(prompt + highlightLine(theme, c.command, 'shell') + label);
        }
    } else if (call.language === 'shell') {
        for (const command of splitShell(call.code)) {
            lines.push(prompt + highlightLine(theme, command, 'shell'));
        }
    } else {
        lines.push(...theme.highlight(call.code, HIGHLIGHT_LANGUAGE[language]));
    }
    return lines;
}

/**
 * the result slot's expanded lines: full status and stdout/stderr, or `[]`
 * when there is no result yet (pi does not invoke this slot in that case
 * either; `updateDisplay()` only calls the result renderer `if (this.result)`).
 */
export function expandResult(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
    theme: PreviewTheme = PLAIN_THEME,
): string[] {
    if (!outcome) return [];
    switch (outcome.kind) {
        case 'empty':
            return stream(theme, 'stdout', '');
        case 'ok':
            return call.tool === 'ctx_batch_execute'
                ? [theme.fg('toolOutput', outcome.stdout)]
                : stream(theme, 'stdout', outcome.stdout);
        case 'exit':
            return [
                theme.fg('error', `Exit code: ${outcome.code}`),
                '',
                ...stream(theme, 'stdout', outcome.stdout),
                ...stream(theme, 'stderr', outcome.stderr),
            ];
        case 'timeout':
            return [
                theme.fg('error', `timed out after ${outcome.ms}ms`),
                '',
                ...stream(theme, 'stderr', outcome.stderr),
            ];
        case 'partial':
            return [
                theme.fg('warning', outcome.state === 'backgrounded'
                    ? `backgrounded after ${outcome.ms}ms, still running`
                    : `timed out after ${outcome.ms}ms, partial output`),
                '',
                ...stream(theme, 'stdout', outcome.stdout),
            ];
        case 'indexed':
            return outcome.body.split('\n').map((l) => theme.fg('toolOutput', l));
    }
}

/** @deprecated demo/test convenience; the real renderer calls expandCall and expandResult separately, as pi does. */
export function expand(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
    theme: PreviewTheme = PLAIN_THEME,
): string[] {
    return [...expandCall(call, theme), '', ...expandResult(call, outcome, theme)];
}

/**
 * a labelled block of output. empty stderr is the ordinary case and is
 * omitted rather than shown as "nothing here"; empty stdout still says so,
 * since a command that ran and printed nothing is worth stating. one line
 * folds onto the label; more than one gets the label alone, then each line
 * dimmed and indented by one space, no border.
 */
function stream(theme: PreviewTheme, label: 'stdout' | 'stderr', text: string): string[] {
    const color: PreviewColor = label === 'stderr' ? 'error' : 'muted';
    const trimmed = text.trim();
    if (trimmed === '') {
        if (label === 'stderr') return [];
        return [theme.fg(color, `${label}: `) + theme.fg('dim', '[no output]')];
    }
    const body = trimmed.split('\n');
    if (body.length === 1) {
        return [theme.fg(color, `${label}: `) + theme.fg('dim', body[0]!)];
    }
    return [
        theme.fg(color, `${label}:`),
        ...body.map((l) => ' ' + theme.fg('dim', l)),
    ];
}
