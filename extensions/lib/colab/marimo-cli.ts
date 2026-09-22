// Which `marimo` to run, and running it.
//
// A notebook is opened with the interpreter that owns its dependencies, and
// there are four candidates. A notebook carrying PEP 723 metadata (`# ///
// script`) is self-contained and wants `--sandbox`, which builds its
// environment from that block; the flag needs uv. A project with marimo in
// its pyproject wants the project's interpreter: `.venv/bin/marimo` when the
// venv exists, `uv run marimo` otherwise. Failing both, a `marimo` on PATH,
// and failing that `uvx marimo`, which installs one on the fly.
//
// The same runner runs the file commands (`check`, `export`, `convert`), so a
// lint of a project notebook sees the project's marimo version.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Runner {
    /** argv prefix: ['marimo'] or ['uv', 'run', 'marimo'] or ['/x/.venv/bin/marimo']. */
    readonly argv: readonly string[];
    readonly kind: 'venv' | 'uv' | 'path' | 'uvx';
    /** where the choice came from, for the person. */
    readonly reason: string;
}

export interface RunResult {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

export const PEP723 = /^# \/\/\/ script\s*$/m;

export function hasInlineMetadata(path: string): boolean {
    try {
        return PEP723.test(readFileSync(path, 'utf8').slice(0, 4_000));
    } catch {
        return false;
    }
}

/** whether a file is a marimo notebook: it builds a `marimo.App`. */
export function isNotebook(path: string): boolean {
    if (!path.endsWith('.py')) return false;
    try {
        const head = readFileSync(path, 'utf8');
        return /^import marimo\b/m.test(head) && /marimo\.App\(/.test(head);
    } catch {
        return false;
    }
}

function findUp(start: string, name: string): string | null {
    let dir = resolve(start);
    for (;;) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function pyprojectNamesMarimo(pyproject: string): boolean {
    try {
        const text = readFileSync(pyproject, 'utf8');
        return /["']marimo(\[[^\]]*\])?\s*[>=<~!;"']/.test(text) || /["']marimo["']/.test(text);
    } catch {
        return false;
    }
}

function onPath(name: string): boolean {
    const path = process.env.PATH ?? '';
    for (const dir of path.split(':')) {
        if (dir === '') continue;
        try {
            const candidate = join(dir, name);
            if (statSync(candidate).isFile()) return true;
        } catch {
            // not here
        }
    }
    return false;
}

/**
 * choose the runner for a notebook in `cwd`. `sandbox` is decided by the
 * caller and only checked for feasibility here.
 */
export function chooseRunner(cwd: string, prefer: 'auto' | 'marimo' | 'uv' | 'uvx' = 'auto'): Runner {
    if (prefer === 'marimo' && onPath('marimo')) return { argv: ['marimo'], kind: 'path', reason: 'configured' };
    if (prefer === 'uv') return { argv: ['uv', 'run', 'marimo'], kind: 'uv', reason: 'configured' };
    if (prefer === 'uvx') return { argv: ['uvx', 'marimo'], kind: 'uvx', reason: 'configured' };

    const venv = findUp(cwd, '.venv');
    if (venv !== null && existsSync(join(venv, 'bin', 'marimo'))) {
        return { argv: [join(venv, 'bin', 'marimo')], kind: 'venv', reason: `${venv} has marimo` };
    }
    const pyproject = findUp(cwd, 'pyproject.toml');
    if (pyproject !== null && pyprojectNamesMarimo(pyproject) && onPath('uv')) {
        return { argv: ['uv', 'run', 'marimo'], kind: 'uv', reason: `${pyproject} names marimo` };
    }
    if (onPath('marimo')) return { argv: ['marimo'], kind: 'path', reason: 'marimo on PATH' };
    if (onPath('uvx')) return { argv: ['uvx', 'marimo'], kind: 'uvx', reason: 'no project marimo; uvx installs one' };
    if (onPath('uv')) return { argv: ['uv', 'run', '--with', 'marimo', 'marimo'], kind: 'uv', reason: 'uv only' };
    throw new Error('no marimo found: install marimo, or uv (https://docs.astral.sh/uv/)');
}

/** whether `--sandbox` is the right call for this file under this runner. */
export function wantsSandbox(path: string, mode: 'auto' | 'always' | 'never'): boolean {
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return hasInlineMetadata(path);
}

export function run(
    runner: Runner,
    args: readonly string[],
    cwd: string,
    options: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
    const [command, ...prefix] = runner.argv;
    return new Promise((resolveResult) => {
        const child = spawn(command!, [...prefix, ...args], {
            cwd,
            env: { ...process.env, ...options.env, MARIMO_SKIP_UPDATE_CHECK: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 300_000);
        const onAbort = () => child.kill('SIGTERM');
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.on('error', (error) => {
            clearTimeout(timer);
            resolveResult({ code: null, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            resolveResult({ code, stdout, stderr });
        });
    });
}

export interface LintFinding {
    readonly file: string;
    readonly code: string;
    readonly name: string;
    /** marimo's scale: breaking, runtime, formatting. */
    readonly severity: string;
    readonly message: string;
    /** marimo's suggested fix, when it gives one. */
    readonly hint: string | null;
    readonly line: number | null;
    readonly cells: readonly string[];
    readonly fixable: 'yes' | 'unsafe' | 'no';
}

export interface LintReport {
    readonly findings: LintFinding[];
    readonly files: number;
    readonly filesWithIssues: number;
    readonly fixed: number;
}

/**
 * `marimo check --format json`: one document, `issues` and a `summary`. Every
 * field is read defensively, since the shape is young, and a body that is not
 * json at all comes back as one finding carrying the text.
 */
export function parseLint(stdout: string): LintReport {
    const findings: LintFinding[] = [];
    const text = stdout.trim();
    const empty = { findings, files: 0, filesWithIssues: 0, fixed: 0 };
    if (text === '') return empty;
    let whole: unknown;
    try {
        whole = JSON.parse(text);
    } catch {
        findings.push({ file: '', code: '', name: '', severity: 'info', message: text, hint: null, line: null, cells: [], fixable: 'no' });
        return empty;
    }
    const record = (typeof whole === 'object' && whole !== null ? whole : {}) as Record<string, unknown>;
    const issues = Array.isArray(record.issues) ? record.issues : Array.isArray(whole) ? whole : [];
    for (const raw of issues) {
        const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
        if (r.type !== undefined && r.type !== 'diagnostic') continue;
        findings.push({
            file: String(r.filename ?? r.file ?? ''),
            code: String(r.code ?? ''),
            name: String(r.name ?? ''),
            severity: String(r.severity ?? 'formatting'),
            message: String(r.message ?? ''),
            hint: typeof r.fix === 'string' ? r.fix : null,
            line: typeof r.line === 'number' ? r.line : null,
            cells: Array.isArray(r.cell_id) ? r.cell_id.map(String) : typeof r.cell_id === 'string' ? [r.cell_id] : [],
            fixable: r.fixable === true ? 'yes' : r.fixable === 'unsafe' ? 'unsafe' : 'no',
        });
    }
    const summary = (typeof record.summary === 'object' && record.summary !== null ? record.summary : {}) as Record<string, unknown>;
    const n = (key: string) => (typeof summary[key] === 'number' ? (summary[key] as number) : 0);
    return { findings, files: n('total_files'), filesWithIssues: n('files_with_issues'), fixed: n('fixed_issues') };
}
