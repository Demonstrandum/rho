import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { expandCall, expandResult } from '../extensions/lib/tool-row/exec';
import type { ExecCall, ExecOutcome } from '../extensions/lib/tool-row/exec';

/**
 * pi throws when a rendered line is wider than the terminal, and the throw
 * takes the session down: a long command in an expanded row killed pi outright.
 * Every line these produce has to fit.
 */

const WIDTH = 60;

const longCommand =
    'nproc; free -h 2>/dev/null | head -3; df -h / 2>/dev/null | head -3; ' +
    'nvidia-smi --query-gpu=name,memory.total --format=csv 2>/dev/null || echo "no gpu"';

const shellCall = { tool: 'ctx_execute', language: 'shell', code: longCommand } as unknown as ExecCall;

const fits = (lines: readonly string[]) => lines.every((line) => visibleWidth(line) <= WIDTH);

describe('an expanded call', () => {
    test('wraps a command wider than the terminal', () => {
        const lines = expandCall(shellCall, undefined, WIDTH);
        expect(fits(lines)).toBe(true);
        expect(lines.length).toBeGreaterThan(2);
    });

    test('keeps the whole command, since expanding is how you read it', () => {
        const joined = expandCall(shellCall, undefined, WIDTH).join('');
        expect(joined).toContain('nvidia-smi');
        expect(joined).not.toContain('…');
    });

    test('leaves short commands on one line', () => {
        const call = { tool: 'ctx_execute', language: 'shell', code: 'uname -a' } as unknown as ExecCall;
        const lines = expandCall(call, undefined, WIDTH).filter((line) => line.includes('uname'));
        expect(lines).toHaveLength(1);
    });

    test('a narrow terminal still produces nothing too wide', () => {
        expect(fits(expandCall(shellCall, undefined, 20).map((l) => l))).toBe(true);
    });

    test('no width given means no wrapping, as before', () => {
        const lines = expandCall(shellCall);
        expect(lines.some((line) => visibleWidth(line) > WIDTH)).toBe(true);
    });
});

describe('an expanded result', () => {
    test('wraps output wider than the terminal', () => {
        const outcome = { kind: 'ok', stdout: 'x'.repeat(400) } as unknown as ExecOutcome;
        const lines = expandResult(shellCall, outcome, undefined, WIDTH);
        expect(fits(lines)).toBe(true);
    });
});
