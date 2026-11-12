// collapsed and expanded rows for the two context-mode tools whose argument is
// source code: ctx_execute and ctx_batch.
//
// pure: no pi imports. a renderer feeds it the tool name, the raw tool
// arguments, the result text, a width, and a theme (theme.ts), and gets back
// styled strings. preview.ts is the same job for every other tool, where the
// arguments are read as they are rather than parsed as a command.
//
// three pieces:
//   parseExecCall    unvalidated tool args -> a typed call, or null
//   parseExecResult  raw result text and its error flag -> the code echo plus
//                    a typed outcome
//   collapse/expand  a call and an outcome -> lines to draw
//
// shortening is a ladder per part: every command carries its renderings from
// longest to shortest, and fitLadders degrades the widest part until the join
// fits the budget. one command keeping its arguments while its neighbour is
// down to a bare head is the result of that, not a special case.

import { BRACKET, elidePath, ELLIPSIS, oneLine, quantity, truncate } from '../core/text';
import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { PLAIN_THEME, type RowColor, type RowTheme } from './theme';
import { toolTitle } from './title';

// context-mode names five and runs any other runtime on PATH by name; these are
// the ones a row knows how to highlight.
export const EXEC_LANGUAGES = [
    'javascript', 'typescript', 'python', 'shell', 'powershell', 'ruby',
    'go', 'rust', 'php', 'perl', 'r', 'elixir', 'csharp',
] as const;

export type ExecLanguage = (typeof EXEC_LANGUAGES)[number];

function isExecLanguage(value: unknown): value is ExecLanguage {
    return typeof value === 'string' && (EXEC_LANGUAGES as readonly string[]).includes(value);
}

export const EXEC_TOOLS = ['ctx_execute', 'ctx_batch'] as const;

export type ExecToolName = (typeof EXEC_TOOLS)[number];

export function isExecTool(name: string): name is ExecToolName {
    return (EXEC_TOOLS as readonly string[]).includes(name);
}

export type ExecCall =
    | {
        tool: 'ctx_execute';
        language: ExecLanguage;
        code: string;
        /** a file the code reads, handed over in CTX_FILE. */
        file?: string;
        intent?: string;
        background?: boolean;
        timeoutMs?: number;
    }
    | { tool: 'ctx_batch'; commands: string[]; queries: string[] };

// args arrive mid-stream, so every field is optional until it is not.
export function parseExecCall(tool: string, args: unknown): ExecCall | null {
    if (!isExecTool(tool) || args === null || typeof args !== 'object') return null;
    const a = args as Record<string, unknown>;
    const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
    switch (tool) {
        case 'ctx_execute':
            return {
                tool,
                language: isExecLanguage(a.language) ? a.language : 'shell',
                code: typeof a.code === 'string' ? a.code : '',
                file: typeof a.file === 'string' ? a.file : undefined,
                intent: typeof a.intent === 'string' ? a.intent : undefined,
                background: a.background === true,
                timeoutMs: typeof a.timeoutMs === 'number' ? a.timeoutMs : undefined,
            };
        case 'ctx_batch':
            return { tool, commands: strings(a.commands), queries: strings(a.queries) };
    }
}

// context-mode merges stderr into the output of a command that exits nonzero
// and drops it otherwise, so an outcome carries one output, not two streams.
//
// `indexed` is set when the reply shows fewer bytes than the command printed:
// the rest went to the knowledge base, and what is shown is the sections that
// matched the intent.
export type ExecOutcome =
    | { kind: 'empty' }
    | { kind: 'ok'; stdout: string; indexed: boolean }
    /** `failed` is false for a shell exit 1 with no stderr, which context-mode does not count as an error (grep finding nothing). */
    | { kind: 'exit'; code: number; output: string; indexed: boolean; failed: boolean }
    | { kind: 'timeout'; ms: number }
    | { kind: 'background'; pid: number }
    | { kind: 'cancelled' }
    /** any other refusal context-mode reports: a path outside the project, no runtime, a failed spawn. */
    | { kind: 'failed'; message: string };

export interface ExecEcho {
    language?: string;
    code?: string;
}

export interface ParsedExecResult {
    echo?: ExecEcho;
    outcome: ExecOutcome;
}

// the reply shapes of context-mode 2.x (src/core/tools/execute.ts): a clean
// exit with output is the bare output; anything else opens with the summary
// line, then the code echo when `summary` was asked for, then the output.
const SUMMARY = /^exit (\d+) \u00b7 (\d+) B(?:\n|$)/;
const ECHO = /^```(?<lang>[\w-]*)\n(?<code>[\s\S]*?)\n```\n?/;
const TIMEOUT = /^Timed out after (\d+) ms\./;
const BACKGROUND = /^started in background, pid (\d+)\s*$/;
const CANCELLED = 'Cancelled.';

export function parseExecResult(text: string, isError = false): ParsedExecResult {
    const summary = SUMMARY.exec(text);
    if (summary === null) return { outcome: parseBare(text, isError) };
    const rest = text.slice(summary[0].length);
    const match = ECHO.exec(rest);
    const echo: ExecEcho | undefined = match?.groups
        ? { language: match.groups.lang || undefined, code: match.groups.code }
        : undefined;
    const shown = match ? rest.slice(match[0].length) : rest;
    const output = shown.trim();
    const code = Number(summary[1]);
    // counted before the trim: the byte count includes the trailing newline.
    const indexed = new TextEncoder().encode(shown).length < Number(summary[2]);
    if (code === 0) return { echo, outcome: output === '' ? { kind: 'empty' } : { kind: 'ok', stdout: output, indexed } };
    return { echo, outcome: { kind: 'exit', code, output, indexed, failed: isError } };
}

function parseBare(text: string, isError: boolean): ExecOutcome {
    const trimmed = text.trim();
    const timeout = TIMEOUT.exec(trimmed);
    if (timeout) return { kind: 'timeout', ms: Number(timeout[1]) };
    if (trimmed === CANCELLED) return { kind: 'cancelled' };
    if (isError) return { kind: 'failed', message: trimmed };
    const background = BACKGROUND.exec(trimmed);
    if (background) return { kind: 'background', pid: Number(background[1]) };
    if (trimmed === '') return { kind: 'empty' };
    return { kind: 'ok', stdout: trimmed, indexed: false };
}

// a part's renderings, longest first. never empty.
export type Ladder = readonly [string, ...string[]];

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
    return { text: truncate(parts[0]!, budget), exact: false };
}

export function fitLadders(ladders: readonly Ladder[], budget: number, sep = '; '): string {
    return fitLaddersDetailed(ladders, budget, sep).text;
}

const PATH_TOKEN = /^-{0,2}[\w.]*=?(\/[^\s]*|~\/[^\s]*)$/;
const TEMP_SCRIPT = /(?:\/[^\s:]+)+\/([\w.-]+)(?=:\d+)/g;

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
    const full = oneLine(command);
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
    const tag = `${language} ${quantity(count, 'line')}`;
    const rungs = [
        count > 1 ? `${flat} ${BRACKET} +${count - 1}` : flat,
        `${truncate(flat, 40)} ${BRACKET}`,
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
    powershell: /^(?:#|Import-Module )/,
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
            return call.language === 'shell'
                ? splitShell(call.code).map(shellLadder)
                : [codeLadder(call.language, call.code)];
        case 'ctx_batch':
            return call.commands.flatMap(splitShell).map(shellLadder);
    }
}

// highlight.js knows shells as bash; the rest of the languages carry their own
// name through.
const HIGHLIGHT_LANGUAGE: Record<ExecLanguage, string> = {
    javascript: 'javascript',
    typescript: 'typescript',
    python: 'python',
    shell: 'bash',
    powershell: 'powershell',
    ruby: 'ruby',
    go: 'go',
    rust: 'rust',
    php: 'php',
    perl: 'perl',
    r: 'r',
    elixir: 'elixir',
    csharp: 'csharp',
};

function highlightLine(theme: RowTheme, text: string, language: ExecLanguage): string {
    return theme.highlight(text, HIGHLIGHT_LANGUAGE[language])[0] ?? text;
}

function callLanguage(call: ExecCall): ExecLanguage {
    return call.tool === 'ctx_batch' ? 'shell' : call.language;
}

export interface CollapsedPreview {
    /** the call line: verb, shortened source, status tag. */
    call: string;
    /** the output line, or undefined when there is nothing to show. */
    output?: string;
}

// the same names every other row is titled with, so a preview and a plain row
// never call one tool two things.
const VERB: Record<ExecToolName, string> = {
    ctx_execute: toolTitle('ctx_execute'),
    ctx_batch: toolTitle('ctx_batch'),
};

interface StatusTag {
    text: string;
    color: RowColor;
}

function statusTag(outcome: ExecOutcome | undefined): StatusTag | undefined {
    if (!outcome) return undefined;
    switch (outcome.kind) {
        // no "code:" label: the bubble is already the error colour, so the
        // number alone reads as the exit status.
        case 'exit': return { text: `[${outcome.code}]`, color: outcome.failed ? 'error' : 'warning' };
        case 'timeout': return { text: `[timeout ${outcome.ms}ms]`, color: 'error' };
        case 'background': return { text: `[background ${outcome.pid}]`, color: 'warning' };
        case 'cancelled': return { text: '[cancelled]', color: 'warning' };
        case 'failed': return { text: '[error]', color: 'error' };
        case 'empty': return { text: '[no output]', color: 'dim' };
        case 'ok': return outcome.indexed ? { text: '[indexed]', color: 'accent' } : undefined;
    }
}

// ctx_batch's reply is its answers to the queries, under one `## query`
// heading each, not a captured output. it does not get the output treatment:
// no label, no dim.
function isBatchAnswer(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
): outcome is Extract<ExecOutcome, { kind: 'ok' }> {
    return call.tool === 'ctx_batch' && outcome?.kind === 'ok';
}

// the call line never carries a status tag: pi renders the call slot (this
// function) and the result slot (outputDigest, below) as two independently
// invoked components, and only the result slot ever sees the parsed outcome.
// putting the tag on the output line also places it next to the label it
// qualifies, e.g. "[1] stderr: ...", instead of dangling after the command.
export function collapseCall(call: ExecCall, width: number, theme: RowTheme = PLAIN_THEME): string {
    const verb = VERB[call.tool];
    const budget = Math.max(8, width - verb.length - 3);
    const source = fitLadders(callLadders(call), budget);
    const rendered = theme.fg('dim', '`') + highlightLine(theme, source, callLanguage(call)) + theme.fg('dim', '`');
    return theme.fg('toolTitle', theme.bold(verb)) + ' ' + rendered;
}

/** the result slot's collapsed line: status tag, if any, then the output digest. */
export function collapseResult(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
    width: number,
    theme: RowTheme = PLAIN_THEME,
): string | undefined {
    const tag = statusTag(outcome);
    const tagWidth = tag ? tag.text.length + 1 : 0;
    const digest = isBatchAnswer(call, outcome)
        ? theme.fg('toolOutput', truncate(oneLine(outcome.stdout), Math.max(8, width - tagWidth)))
        : outputDigest(outcome, Math.max(8, width - tagWidth), theme);
    if (!tag) return digest;
    return digest ? `${theme.fg(tag.color, tag.text)} ${digest}` : theme.fg(tag.color, tag.text);
}

/** @deprecated demo/test convenience; the real renderer calls collapseCall and collapseResult separately, as pi does. */
export function collapse(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
    width: number,
    theme: RowTheme = PLAIN_THEME,
): CollapsedPreview {
    return { call: collapseCall(call, width, theme), output: collapseResult(call, outcome, width, theme) };
}

/** one line from the output: the stream that carries the failure, if any. */
export function outputDigest(
    outcome: ExecOutcome | undefined,
    width: number,
    theme: RowTheme = PLAIN_THEME,
): string | undefined {
    if (!outcome) return undefined;
    const picked = pickStream(outcome);
    if (!picked) return undefined;
    const { label, text } = picked;
    const lines = elideScriptPaths(text)
        .split('\n')
        .map(oneLine)
        .filter((l) => l !== '');
    if (lines.length === 0) return undefined;
    const prefix = `${label}: `;
    const sep = ` ${ELLIPSIS} `;
    const { text: joined, exact } = fitLaddersDetailed(
        lines.map((l) => [l, truncate(l, 40)] as Ladder),
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
    return theme.fg(STREAM_COLOR[label], prefix) + styled;
}

/** `stdout` is a clean run's output; `output` is a failed run's, stdout and stderr merged; `error` is context-mode's own refusal. */
type StreamLabel = 'stdout' | 'output' | 'error';

const STREAM_COLOR: Record<StreamLabel, RowColor> = { stdout: 'muted', output: 'error', error: 'error' };

function pickStream(outcome: ExecOutcome): { label: StreamLabel; text: string } | undefined {
    switch (outcome.kind) {
        case 'empty':
        case 'timeout':
        case 'background':
        case 'cancelled':
            return undefined;
        case 'ok': return { label: 'stdout', text: outcome.stdout };
        case 'exit': return { label: outcome.failed ? 'output' : 'stdout', text: outcome.output };
        case 'failed': return { label: 'error', text: outcome.message };
    }
}

/**
 * Expanded lines, wrapped to the terminal.
 *
 * pi throws when a rendered line is wider than the terminal, which takes the
 * whole session down, so a long command used to crash rather than spill. The
 * expanded view exists to show the whole command, so it wraps rather than
 * truncating: nothing is hidden behind an ellipsis in the one view whose job
 * is to show everything.
 */
function wrapped(lines: readonly string[], width: number | undefined): string[] {
    if (width === undefined || width <= 0) return [...lines];
    const out: string[] = [];
    for (const line of lines) {
        if (visibleWidth(line) <= width) {
            out.push(line);
            continue;
        }
        out.push(...wrapTextWithAnsi(line, width));
    }
    return out;
}

/** the call slot's expanded lines: verb, the file the code reads, full command(s)/code. */
export function expandCall(call: ExecCall, theme: RowTheme = PLAIN_THEME, width?: number): string[] {
    const language = callLanguage(call);
    const prompt = theme.fg('dim', '$ ');
    const lines: string[] = [theme.fg('toolTitle', theme.bold(VERB[call.tool]))];

    if (call.tool === 'ctx_execute' && call.file !== undefined) {
        lines.push('', theme.fg('muted', 'file=') + theme.fg('text', call.file));
    }
    lines.push('');
    if (call.tool === 'ctx_batch') {
        for (const command of call.commands) {
            lines.push(prompt + highlightLine(theme, command, 'shell'));
        }
        if (call.queries.length > 0) {
            lines.push('', theme.fg('muted', 'queries: ') + theme.fg('text', call.queries.join(' \u00b7 ')));
        }
    } else if (call.language === 'shell') {
        for (const command of splitShell(call.code)) {
            lines.push(prompt + highlightLine(theme, command, 'shell'));
        }
    } else {
        lines.push(...theme.highlight(call.code, HIGHLIGHT_LANGUAGE[language]));
    }
    return wrapped(lines, width);
}

/**
 * the result slot's expanded lines: full status and stdout/stderr, or `[]`
 * when there is no result yet (pi does not invoke this slot in that case
 * either; `updateDisplay()` only calls the result renderer `if (this.result)`).
 */
export function expandResult(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
    theme: RowTheme = PLAIN_THEME,
    width?: number,
): string[] {
    return wrapped(expandedResult(call, outcome, theme), width);
}

function expandedResult(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
    theme: RowTheme = PLAIN_THEME,
): string[] {
    if (!outcome) return [];
    switch (outcome.kind) {
        case 'empty':
            return stream(theme, 'stdout', '');
        case 'ok':
            if (call.tool === 'ctx_batch') return outcome.stdout.split('\n').map((l) => theme.fg('toolOutput', l));
            return [
                ...(outcome.indexed ? [theme.fg('accent', 'indexed: the sections that matched the intent'), ''] : []),
                ...stream(theme, 'stdout', outcome.stdout),
            ];
        case 'exit':
            return [
                theme.fg(outcome.failed ? 'error' : 'warning', `exit code ${outcome.code}`),
                '',
                ...stream(theme, outcome.failed ? 'output' : 'stdout', outcome.output),
            ];
        case 'timeout':
            return [theme.fg('error', `timed out after ${outcome.ms}ms`)];
        case 'background':
            return [theme.fg('warning', `running in the background, pid ${outcome.pid}`)];
        case 'cancelled':
            return [theme.fg('warning', 'cancelled')];
        case 'failed':
            return stream(theme, 'error', outcome.message);
    }
}

/** @deprecated demo/test convenience; the real renderer calls expandCall and expandResult separately, as pi does. */
export function expand(
    call: ExecCall,
    outcome: ExecOutcome | undefined,
    theme: RowTheme = PLAIN_THEME,
): string[] {
    return [...expandCall(call, theme), '', ...expandResult(call, outcome, theme)];
}

/**
 * a labelled block of output. empty output still says so, since a command
 * that ran and printed nothing is worth stating. one line folds onto the
 * label; more than one gets the label alone, then each line dimmed and
 * indented by one space, no border.
 */
function stream(theme: RowTheme, label: StreamLabel, text: string): string[] {
    const color = STREAM_COLOR[label];
    const trimmed = text.trim();
    if (trimmed === '') {
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
