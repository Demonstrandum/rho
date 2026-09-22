// How a notebook is described to the model.
//
// Text, aligned, one cell per line: the model reads a table faster than json,
// and the ids it needs to act (`Hbol`) sit in the first column. Errors are
// spelled in full, since the error is what the model came for; outputs are
// clipped by the helper before they get here.

import type { LintFinding, LintReport } from './marimo-cli';

export interface CellRecord {
    readonly id: string;
    readonly name: string | null;
    readonly status: string | null;
    readonly lines: number;
    readonly defs: readonly string[];
    readonly refs: readonly string[];
    readonly errors: readonly { kind: string; msg: string }[];
    readonly code?: string;
    readonly preview?: string;
    readonly has_output?: boolean;
    readonly output?: OutputRecord | null;
    readonly console?: readonly { channel: string; text: string | null }[];
    /** the last run's length, from the feed; absent when never seen running. */
    readonly runMs?: number | null;
}

/** "1.2s", "340ms", "2m 05s": a run's length, at the grain that reads. */
export function runLength(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export interface OutputRecord {
    readonly mimetype: string;
    readonly text?: string | null;
    readonly image?: string;
}

export interface CellsAnswer {
    readonly count: number;
    readonly cells: readonly CellRecord[];
    readonly errored: readonly string[];
    readonly stale?: readonly string[];
    readonly error?: string;
}

const pad = (text: string, width: number): string => (text.length >= width ? text : text + ' '.repeat(width - text.length));

/** the one-line table row for a cell. */
export function cellLine(cell: CellRecord): string {
    const status = cell.errors.length > 0 ? 'ERROR' : (cell.status ?? '-');
    const name = cell.name !== null && cell.name !== '' && cell.name !== '_' ? ` (${cell.name})` : '';
    const preview = cell.preview ?? cell.code?.split('\n', 1)[0] ?? '';
    const more = cell.lines > 1 ? ` [+${cell.lines - 1}]` : '';
    const names: string[] = [];
    if (cell.defs.length > 0) names.push(`defs ${cell.defs.join(', ')}`);
    if (cell.refs.length > 0) names.push(`refs ${cell.refs.join(', ')}`);
    const tail = names.length > 0 ? `    ${names.join('; ')}` : '';
    // a run over a second is worth a word: it is what makes a notebook slow
    const took = cell.runMs !== undefined && cell.runMs !== null && cell.runMs >= 1000 ? `  (${runLength(cell.runMs)})` : '';
    return `${pad(cell.id, 5)} ${pad(status, 8)} ${preview}${more}${name}${tail}${took}`;
}

export function errorLines(cell: CellRecord): string[] {
    return cell.errors.map((e) => `    ${e.kind}: ${e.msg.replace(/\n/g, '\n    ')}`);
}

/** the whole notebook, one line per cell, errors under the cells that have them. */
export function cellTable(answer: CellsAnswer): string {
    const lines: string[] = [];
    for (const cell of answer.cells) {
        lines.push(cellLine(cell));
        lines.push(...errorLines(cell));
    }
    return lines.join('\n');
}

/** a cell in full: code, then output, console and errors. */
export function cellDetail(cell: CellRecord): string {
    const lines: string[] = [cellLine(cell)];
    if (cell.code !== undefined) {
        lines.push('  code:');
        lines.push(...cell.code.split('\n').map((l) => `    ${l}`));
    }
    if (cell.output !== undefined && cell.output !== null) {
        const out = cell.output;
        if (out.image !== undefined) lines.push(`  output: ${out.mimetype} image (attached)`);
        if (out.text !== undefined && out.text !== null && out.text !== '') {
            lines.push(`  output (${out.mimetype}):`);
            lines.push(...out.text.split('\n').map((l) => `    ${l}`));
        }
    } else if (cell.code !== undefined) {
        lines.push('  output: none');
    }
    for (const entry of cell.console ?? []) {
        if (entry.text === null || entry.text === '') continue;
        lines.push(`  ${entry.channel}:`);
        lines.push(...entry.text.split('\n').map((l) => `    ${l}`));
    }
    if (cell.errors.length > 0) {
        lines.push('  errors:');
        lines.push(...errorLines(cell));
    }
    return lines.join('\n');
}

export function lintText(report: LintReport, fixed: boolean): string {
    if (report.findings.length === 0) {
        return fixed && report.fixed > 0 ? `${report.fixed} issues fixed; none remain` : 'no issues';
    }
    const byFile = new Map<string, LintFinding[]>();
    for (const f of report.findings) {
        const list = byFile.get(f.file) ?? [];
        list.push(f);
        byFile.set(f.file, list);
    }
    const lines: string[] = [];
    for (const [file, findings] of byFile) {
        lines.push(file === '' ? '(no file)' : file);
        for (const f of findings) {
            const where = f.line !== null ? `:${f.line}` : '';
            const fix = f.fixable === 'yes' ? ' [fixable]' : f.fixable === 'unsafe' ? ' [fixable with unsafe fixes]' : '';
            lines.push(`  ${f.severity} ${f.code} ${f.name}${where}: ${f.message}${fix}`);
            if (f.hint !== null) lines.push(`    hint: ${f.hint}`);
        }
    }
    const head = `${report.findings.length} ${report.findings.length === 1 ? 'issue' : 'issues'} in ${report.filesWithIssues} of ${report.files} files${fixed ? `, ${report.fixed} fixed` : ''}`;
    return `${head}\n${lines.join('\n')}`;
}

/** clip a block of text, saying how much was left out. */
export function clip(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n… [${text.length - limit} more characters]`;
}
