import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExecuteStream, stripHtml } from '../extensions/lib/colab/client';
import { NotebookMirror } from '../extensions/lib/colab/mirror';
import { hasInlineMetadata, isNotebook, parseLint } from '../extensions/lib/colab/marimo-cli';
import { cellLine, cellTable, lintText } from '../extensions/lib/colab/format';
import { helperCall, readAnswer } from '../extensions/lib/colab/helper';

// ---- client -----------------------------------------------------------

test('an execute stream yields stdout, stderr and the result', () => {
    const stream = [
        'event: stdout',
        'data: {"data": "hello\\n"}',
        '',
        'event: stderr',
        'data: {"data": "warn\\n"}',
        '',
        'event: done',
        'data: {"success": true, "output": {"mimetype": "text/plain", "data": "42"}}',
        '',
    ].join('\n');
    const parsed = parseExecuteStream(stream);
    expect(parsed).toEqual({ ok: true, stdout: 'hello\n', stderr: 'warn\n', result: '42' });
});

test('an html result is unwrapped to its text', () => {
    const stream = ['event: done', "data: {\"success\": true, \"output\": {\"mimetype\": \"text/html\", \"data\": \"<pre class='x'>&#x27;a\\\\nb&#x27;</pre>\"}}", ''].join('\n');
    expect(parseExecuteStream(stream).result).toBe("'a\\nb'");
});

test('a stream with no done event is a failure carrying the body', () => {
    const parsed = parseExecuteStream('{"detail": "Missing server token"}');
    expect(parsed.ok).toBe(false);
    expect(parsed.stderr).toContain('Missing server token');
});

test('a failed run keeps its stderr and is not ok', () => {
    const stream = ['event: stderr', 'data: {"data": "NameError: x"}', '', 'event: done', 'data: {"success": false, "output": null}', ''].join('\n');
    const parsed = parseExecuteStream(stream);
    expect(parsed.ok).toBe(false);
    expect(parsed.stderr).toBe('NameError: x');
});

test('stripHtml drops tags and undoes entities', () => {
    expect(stripHtml('<div>a &lt; b</div><p>c&amp;d</p>')).toBe('a < b\nc&d');
});

// ---- mirror -----------------------------------------------------------

const ready = {
    op: 'kernel-ready',
    data: { cell_ids: ['A', 'B'], codes: ['x = 1', 'y = x + 1'], names: ['_', 'second'] },
};

test('kernel-ready seeds the cells in order', () => {
    const m = new NotebookMirror();
    m.apply(ready);
    expect(m.list().map((c) => c.id)).toEqual(['A', 'B']);
    expect(m.cell('B')?.name).toBe('second');
    expect(m.ready).toBe(true);
    expect(m.summary()).toBe('2 cells');
});

test('a cell-op moves status and records an error output', () => {
    const m = new NotebookMirror();
    m.apply(ready);
    m.apply({ op: 'cell-op', data: { cell_id: 'B', status: 'running' } });
    expect(m.running).toBe(1);
    m.apply({
        op: 'cell-op',
        data: {
            cell_id: 'B',
            status: 'idle',
            output: { mimetype: 'application/vnd.marimo+error', data: [{ type: 'exception', exception_type: 'NameError', msg: "name 'x' is not defined" }] },
        },
    });
    expect(m.running).toBe(0);
    expect(m.errored.map((c) => c.id)).toEqual(['B']);
    expect(m.cell('B')?.error).toBe("NameError: name 'x' is not defined");
    expect(m.summary()).toBe('2 cells · 1 error');
    // a clean output clears it
    m.apply({ op: 'cell-op', data: { cell_id: 'B', output: { mimetype: 'text/plain', data: '2' } } });
    expect(m.errored).toEqual([]);
    expect(m.cell('B')?.hasOutput).toBe(true);
});

test('a cell-op for an unannounced cell (the scratchpad) is ignored', () => {
    const m = new NotebookMirror();
    m.apply(ready);
    m.apply({ op: 'cell-op', data: { cell_id: '__scratch__', status: 'running' } });
    expect(m.list().length).toBe(2);
    expect(m.running).toBe(0);
});

test('document transactions add, edit, move and delete cells and are remembered by source', () => {
    const m = new NotebookMirror();
    m.apply(ready);
    const before = Date.now() - 1;
    m.apply({
        op: 'notebook-document-transaction',
        data: {
            transaction: {
                source: 'frontend',
                changes: [
                    { type: 'create-cell', cellId: 'C', code: 'z = 3', name: '', after: 'A' },
                    { type: 'set-code', cellId: 'A', code: 'x = 10' },
                ],
            },
        },
    });
    expect(m.list().map((c) => c.id)).toEqual(['A', 'C', 'B']);
    expect(m.cell('A')?.code).toBe('x = 10');
    m.apply({ op: 'notebook-document-transaction', data: { transaction: { source: 'code-mode', changes: [{ type: 'move-cell', cellId: 'C', before: 'A' }, { type: 'delete-cell', cellId: 'B' }] } } });
    expect(m.list().map((c) => c.id)).toEqual(['C', 'A']);
    const theirs = m.activitySince(before).filter((a) => a.source === 'frontend');
    expect(theirs.map((a) => a.kind)).toEqual(['create-cell', 'set-code']);
});

test('variables and their values are joined by name', () => {
    const m = new NotebookMirror();
    m.apply(ready);
    m.apply({ op: 'variables', data: { variables: [{ name: 'x', declared_by: ['A'], used_by: ['B'] }] } });
    m.apply({ op: 'variable-values', data: { variables: [{ name: 'x', value: '1', datatype: 'int' }] } });
    expect(m.vars()).toEqual([{ name: 'x', declaredBy: ['A'], usedBy: ['B'], datatype: 'int', value: '1' }]);
});

// ---- marimo-cli --------------------------------------------------------

test('parseLint reads marimo check json', () => {
    const out = JSON.stringify({
        issues: [
            { type: 'diagnostic', message: 'star import', filename: 'a.py', line: 16, severity: 'breaking', name: 'invalid-syntax', code: 'MB005', fixable: false, fix: 'use import module' },
            { type: 'diagnostic', message: 'empty', filename: 'a.py', line: 22, severity: 'formatting', name: 'empty-cells', code: 'MF004', fixable: 'unsafe', cell_id: ['2'] },
        ],
        summary: { total_files: 1, files_with_issues: 1, total_issues: 2, fixed_issues: 0, errored: true },
    });
    const report = parseLint(out);
    expect(report.findings.length).toBe(2);
    expect(report.findings[0]).toMatchObject({ code: 'MB005', severity: 'breaking', hint: 'use import module', fixable: 'no', line: 16 });
    expect(report.findings[1]).toMatchObject({ fixable: 'unsafe', cells: ['2'] });
    expect(report.files).toBe(1);
    const text = lintText(report, false);
    expect(text).toContain('2 issues in 1 of 1 files');
    expect(text).toContain('breaking MB005 invalid-syntax:16: star import');
    expect(text).toContain('[fixable with unsafe fixes]');
});

test('parseLint on nothing is no issues', () => {
    expect(lintText(parseLint(''), false)).toBe('no issues');
});

test('notebooks and inline metadata are recognised from the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'colab-'));
    const nb = join(dir, 'nb.py');
    writeFileSync(nb, 'import marimo\n\napp = marimo.App()\n');
    const plain = join(dir, 'plain.py');
    writeFileSync(plain, 'print(1)\n');
    const sandboxed = join(dir, 'sb.py');
    writeFileSync(sandboxed, '# /// script\n# dependencies = ["marimo"]\n# ///\nimport marimo\napp = marimo.App()\n');
    expect(isNotebook(nb)).toBe(true);
    expect(isNotebook(plain)).toBe(false);
    expect(hasInlineMetadata(nb)).toBe(false);
    expect(hasInlineMetadata(sandboxed)).toBe(true);
});

// ---- format -----------------------------------------------------------

test('a cell line names the id, the status, the first line and the names', () => {
    const line = cellLine({ id: 'Hbol', name: 'load', status: 'idle', lines: 3, defs: ['df'], refs: ['pd'], errors: [], preview: 'df = pd.read_csv("x")' });
    expect(line).toBe('Hbol  idle     df = pd.read_csv("x") [+2] (load)    defs df; refs pd');
});

test('an erroring cell is marked and its error follows', () => {
    const table = cellTable({
        count: 1,
        cells: [{ id: 'X', name: null, status: 'idle', lines: 1, defs: [], refs: [], errors: [{ kind: 'runtime', msg: 'NameError: y' }], preview: 'y' }],
        errored: ['X'],
    });
    expect(table).toBe('X     ERROR    y\n    runtime: NameError: y');
});

// ---- helper -----------------------------------------------------------

test('a helper answer is cut out of stdout and the rest kept', () => {
    const code = helperCall('colab_cells', { ids: null, limit: 10 });
    expect(code).toContain('def colab_cells');
    expect(code).toContain('colab_cells(**_args)');
    const answer = readAnswer<{ count: number }>({ ok: true, stdout: 'noise\n<<colab:json>>{"count": 2}<</colab:json>>\n', stderr: '', result: '', ms: 3 });
    expect(answer.data).toEqual({ count: 2 });
    expect(answer.stdout).toBe('noise');
});

test('an async helper is awaited', () => {
    expect(helperCall('colab_edit', { ops: [] })).toContain('await colab_edit(**_args)');
});

test('an interruption reads as one word, and a structured error keeps its fields', () => {
    const m = new NotebookMirror();
    m.apply(ready);
    m.apply({ op: 'cell-op', data: { cell_id: 'A', output: { mimetype: 'application/vnd.marimo+error', data: [{ type: 'interruption' }] } } });
    expect(m.cell('A')?.error).toBe('interrupted');
    m.apply({ op: 'cell-op', data: { cell_id: 'B', output: { mimetype: 'application/vnd.marimo+error', data: [{ type: 'ancestor-prevented', msg: 'An ancestor raised', raising_cell: 'A' }] } } });
    expect(m.cell('B')?.error).toBe('ancestor-prevented: An ancestor raised');
});

test('a running cell is timed from its cell-op, and its run length kept when it ends', () => {
    const m = new NotebookMirror();
    m.apply(ready);
    m.apply({ op: 'cell-op', data: { cell_id: 'A', status: 'running', timestamp: 100 } });
    expect(m.cell('A')?.runningSince).toBe(100_000);
    m.apply({ op: 'cell-op', data: { cell_id: 'A', status: 'idle', timestamp: 102.5 } });
    expect(m.cell('A')?.runMs).toBe(2500);
    expect(m.cell('A')?.runningSince).toBeNull();
});

test('a slow cell shows its run length in the table, a running one how long so far', () => {
    const base = { id: 'A', name: null, status: 'idle', lines: 1, defs: [], refs: [], errors: [], preview: 'x' };
    expect(cellLine({ ...base, runMs: 152_000 })).toContain('(2m 32s)');
    expect(cellLine({ ...base, runMs: 300 })).not.toContain('ms');
    expect(cellLine({ ...base, status: 'running', runMs: 4200 })).toContain('(running for 4.2s)');
});

test('a project layer is found by content: an agent module, a skill, widgets, notebooks', async () => {
    const { inspectProject, labNote, hasLab } = await import('../extensions/lib/colab/project');
    const { mkdirSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'lab-'));
    mkdirSync(join(dir, 'lab', 'widgets'), { recursive: true });
    mkdirSync(join(dir, '.claude', 'skills', 'lab-pair'), { recursive: true });
    mkdirSync(join(dir, 'lab', 'notebooks', 'me'), { recursive: true });
    writeFileSync(join(dir, 'lab', '__init__.py'), '');
    writeFileSync(join(dir, 'lab', 'agent.py'), 'import marimo._code_mode as cm\n\ndef state():\n    return "ok"\n\nasync def knob(k, v):\n    pass\n\ndef _private():\n    pass\n');
    writeFileSync(join(dir, 'lab', 'widgets', 'dash.py'), 'import anywidget\n');
    writeFileSync(join(dir, '.claude', 'skills', 'lab-pair', 'SKILL.md'), '---\nname: lab-pair\n---\npair on the marimo notebook\n');
    writeFileSync(join(dir, 'lab', 'notebooks', 'me', 'nb.py'), 'import marimo\napp = marimo.App()\n');
    writeFileSync(join(dir, 'lab', 'launch.sh'), '#!/bin/sh\nuv run marimo edit "$1" --no-token\n');
    const lab = inspectProject(dir);
    expect(hasLab(lab)).toBe(true);
    expect(lab.agentModules[0]).toMatchObject({ path: 'lab/agent.py', importPath: 'lab.agent', functions: ['state', 'knob'] });
    expect(lab.skills).toEqual(['.claude/skills/lab-pair/SKILL.md']);
    expect(lab.widgetDirs).toEqual(['lab/widgets']);
    expect(lab.launchers).toEqual(['lab/launch.sh']);
    expect(lab.notebookDirs).toEqual([{ path: 'lab/notebooks/me', count: 1 }]);
    expect(labNote(lab)).toContain('import lab.agent (state, knob)');
    expect(hasLab(inspectProject(mkdtempSync(join(tmpdir(), 'empty-'))))).toBe(false);
});
