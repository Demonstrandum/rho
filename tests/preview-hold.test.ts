import { expect, test } from 'bun:test';
import { previewHold } from '../extensions/lib/preview-hold';

function harness(initial: string, fails: ReadonlySet<string> = new Set()) {
    let current = initial;
    const writes: string[] = [];
    const hold = previewHold<string>({
        read: () => current,
        write: (value) => {
            if (fails.has(value)) return false;
            current = value;
            writes.push(value);
            return true;
        },
    });
    return { hold, writes, now: () => current };
}

test('the first preview is what a revert goes back to, not the one before it', () => {
    const { hold, now } = harness('plan9');
    hold.preview('dark');
    hold.preview('light');
    expect(now()).toBe('light');
    hold.revert();
    expect(now()).toBe('plan9');
});

test('a commit leaves what is shown and holds nothing', () => {
    const { hold, now } = harness('plan9');
    hold.preview('dark');
    hold.commit();
    expect(hold.held).toBeUndefined();
    hold.revert();
    expect(now()).toBe('dark');
});

test('a preview that does not take holds nothing', () => {
    const { hold, now, writes } = harness('plan9', new Set(['broken']));
    hold.preview('broken');
    expect(hold.held).toBeUndefined();
    hold.revert();
    expect(now()).toBe('plan9');
    expect(writes).toEqual([]);
});

test('a revert is idempotent, and a second run holds again', () => {
    const { hold, now, writes } = harness('plan9');
    hold.preview('dark');
    hold.revert();
    hold.revert();
    expect(writes).toEqual(['dark', 'plan9']);
    hold.preview('light');
    expect(hold.held).toBe('plan9');
    hold.revert();
    expect(now()).toBe('plan9');
});
