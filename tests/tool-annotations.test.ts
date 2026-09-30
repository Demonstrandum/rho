import { test, expect } from 'bun:test';
import { does } from '../extensions/lib/core/tool-annotations';

test('an effect becomes the four hints, with reach as the open world', () => {
    expect(does('read', 'local')).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    });
    expect(does('replace', 'open')).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    });
});

/**
 * pi's docs give a gate that confirms what Codex confirms: a call is approved
 * without asking only when it is read-only, or declares itself neither
 * destructive nor open-world. these are the hints that gate reads.
 */
test('only a read is approved without asking', () => {
    const asks = (hints: ReturnType<typeof does>): boolean =>
        hints.destructiveHint === true ||
        (!hints.readOnlyHint && ((hints.destructiveHint ?? true) || (hints.openWorldHint ?? true)));

    expect(asks(does('read', 'local'))).toBe(false);
    expect(asks(does('read', 'open'))).toBe(false);
    expect(asks(does('set', 'local'))).toBe(false);
    expect(asks(does('set', 'open'))).toBe(true);
    expect(asks(does('add', 'open'))).toBe(true);
    expect(asks(does('replace', 'local'))).toBe(true);
});
