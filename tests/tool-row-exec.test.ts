import { describe, expect, test } from 'bun:test';
import { parseExecCall, parseExecResult } from '../extensions/lib/tool-row/exec';

// the reply texts are context-mode 2.x's, as its ctx_execute returns them
// (src/core/tools/execute.ts) and as pi hands a thrown one to the renderer.

describe('parseExecResult', () => {
    test('a clean exit with output is the bare output', () => {
        expect(parseExecResult('hi\n').outcome).toEqual({ kind: 'ok', stdout: 'hi', indexed: false });
    });

    test('a clean exit with no output is empty', () => {
        expect(parseExecResult('exit 0 \u00b7 0 B\n').outcome).toEqual({ kind: 'empty' });
    });

    test('a failed exit carries its code and the merged output', () => {
        expect(parseExecResult('exit 3 \u00b7 8 B\nout\nbad\n', true).outcome)
            .toEqual({ kind: 'exit', code: 3, output: 'out\nbad', indexed: false, failed: true });
    });

    test('a shell exit 1 that context-mode did not call an error is not failed', () => {
        const outcome = parseExecResult('exit 1 \u00b7 0 B\n', false).outcome;
        expect(outcome.kind === 'exit' && outcome.failed).toBe(false);
    });

    test('fewer bytes shown than printed means the rest was indexed', () => {
        const outcome = parseExecResult('exit 0 \u00b7 13893 B\n1\n2\n3\nmore: ctx_search(...)').outcome;
        expect(outcome.kind === 'ok' && outcome.indexed).toBe(true);
    });

    test('the code echo of a summary reply is split off', () => {
        const { echo, outcome } = parseExecResult('exit 0 \u00b7 3 B\n```shell\necho hi\n```\nhi\n');
        expect(echo).toEqual({ language: 'shell', code: 'echo hi' });
        expect(outcome).toEqual({ kind: 'ok', stdout: 'hi', indexed: false });
    });

    test('the refusals are told apart', () => {
        expect(parseExecResult('Timed out after 500 ms. Fix: pass background: true.', true).outcome)
            .toEqual({ kind: 'timeout', ms: 500 });
        expect(parseExecResult('Cancelled.', true).outcome).toEqual({ kind: 'cancelled' });
        expect(parseExecResult('started in background, pid 4821').outcome).toEqual({ kind: 'background', pid: 4821 });
        expect(parseExecResult('Path /tmp/x is outside the project. Fix: use a path inside /p.', true).outcome)
            .toEqual({ kind: 'failed', message: 'Path /tmp/x is outside the project. Fix: use a path inside /p.' });
    });
});

describe('parseExecCall', () => {
    test('ctx_execute keeps the file it reads', () => {
        expect(parseExecCall('ctx_execute', { language: 'python', code: 'print(1)', file: 'a.log' }))
            .toMatchObject({ tool: 'ctx_execute', language: 'python', file: 'a.log' });
    });

    test('ctx_batch takes its commands as strings', () => {
        expect(parseExecCall('ctx_batch', { commands: ['ls', 7, 'pwd'], queries: ['x'] }))
            .toEqual({ tool: 'ctx_batch', commands: ['ls', 'pwd'], queries: ['x'] });
    });

    test('the 1.x tool names are not exec tools', () => {
        expect(parseExecCall('ctx_batch_execute', { commands: [] })).toBeNull();
        expect(parseExecCall('ctx_execute_file', { path: 'a' })).toBeNull();
    });
});
