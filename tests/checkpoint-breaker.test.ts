import { test, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESOLVE_STORAGE_EXPORT, installCheckpointFastFail } from '../extensions/lib/checkpoint-breaker';
import { failureAction } from '../extensions/rewind-guard';

const require = createRequire(import.meta.url);
const chunk = join(dirname(require.resolve('@ayulab/pi-rewind')), '@ayulab__pi-checkpoint.js');

test('pi-rewind still exports resolveSessionCheckpointStorage under the pinned name', async () => {
    // the name is minified, so a pi-rewind release can move it. when it moves,
    // installCheckpointFastFail silently does nothing and every turn waits on a
    // checkpoint that cannot succeed.
    const module: Record<string, unknown> = await import(pathToFileURL(chunk).href);
    const resolveStorage = module[RESOLVE_STORAGE_EXPORT];
    expect(typeof resolveStorage).toBe('function');

    const result = await (resolveStorage as (o: { sessionFile: string; cwd: string }) => Promise<unknown>)(
        { sessionFile: join(import.meta.dir, 'no-such-session.jsonl'), cwd: import.meta.dir },
    );
    expect(result).toEqual({ ok: false, reason: 'not-found' });
});

test('a missing storage directory leaves the prototype alone', async () => {
    const installed = await installCheckpointFastFail(
        { sessionFile: join(import.meta.dir, 'no-such-session.jsonl'), cwd: import.meta.dir },
        () => true,
        'tripped',
    );
    expect(installed).toBe(false);
});

test('only checkpoint failures are touched, and only the first is reported', () => {
    expect(failureAction('Rewind completed', false)).toBe('pass');
    expect(failureAction('Rewind completed', true)).toBe('pass');
    expect(failureAction('Checkpoint failed: fatal: adding files failed', false)).toBe('report-once');
    expect(failureAction('Checkpoint failed: fatal: adding files failed', true)).toBe('drop');
});
