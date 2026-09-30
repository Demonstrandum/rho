import { test, expect } from 'bun:test';
import { Value } from 'typebox/value';
import { CELLS_SCHEMA, cellsPayload, readPayload, type CellRecord } from '../extensions/lib/colab/format';

const cell = (over: Partial<CellRecord> = {}): CellRecord => ({
    id: 'Hbol',
    name: 'load',
    status: 'idle',
    lines: 4,
    defs: ['df'],
    refs: ['pd'],
    errors: [],
    ...over,
});

test('the published cells match the schema the tool declares', () => {
    const payload = cellsPayload('/n/analysis.py', {
        count: 2,
        cells: [cell(), cell({ id: 'Wsdf', name: null, errors: [{ kind: 'NameError', msg: "name 'x' is not defined" }] })],
        errored: ['Wsdf'],
        stale: [],
    });
    expect(Value.Check(CELLS_SCHEMA, payload)).toBe(true);
    expect(payload.notebook).toBe('/n/analysis.py');
});

/** an output holds a temporary file path, which does not outlive the call. */
test('a cell output is not published, only whether there was one', () => {
    const payload = readPayload('/n/analysis.py', [cell({ output: { mimetype: 'image/png', image_file: '/tmp/x.png' } })]);
    const first = (payload.cells as Record<string, unknown>[])[0]!;
    expect(first.output).toBeUndefined();
    expect(first.has_output).toBe(true);
    expect(Value.Check(CELLS_SCHEMA, payload)).toBe(true);
});

test('cells read one by one report which of them errored', () => {
    const payload = readPayload('/n/a.py', [cell(), cell({ id: 'Zqq', errors: [{ kind: 'ValueError', msg: 'bad' }] })]);
    expect(payload.errored).toEqual(['Zqq']);
    expect(payload.count).toBe(2);
});
