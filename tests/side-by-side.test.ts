import { test, expect } from 'bun:test';
import type { Component } from '@earendil-works/pi-tui';
import { SideBySide, clip, pad } from '../extensions/lib/tui/side-by-side';
import { visibleWidth } from '../extensions/lib/core/text';

function lines(rendered: readonly string[]): string[] {
    return rendered.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
}

/** a left column of fixed rows, which reports the width it was given. */
function column(rows: readonly string[]): Component & { width: number } {
    return {
        width: 0,
        render(width: number): string[] {
            this.width = width;
            return [...rows];
        },
        invalidate(): void {},
    };
}

const options = {
    leftWidth: 10,
    rule: () => '\x1b[90m | \x1b[39m',
    ruleWidth: 3,
    minWidth: 40,
};

test('the left column is rendered at its width and padded to it', () => {
    const left = column(['one', 'two']);
    const side = new SideBySide(left, () => ['a', 'b'], options);
    const out = lines(side.render(60));
    expect(left.width).toBe(10);
    expect(out[0]).toBe('one        | a');
    expect(out[1]).toBe('two        | b');
});

test('the right column is given what is left and is clipped to it', () => {
    const side = new SideBySide(column(['x']), (width) => [`${width}:${'-'.repeat(40)}`], options);
    const out = lines(side.render(50));
    expect(visibleWidth(out[0]!)).toBe(50);
    expect(out[0]).toStartWith('x          | 37:');
});

test('a short column is filled out by the taller one', () => {
    const side = new SideBySide(column(['only']), () => ['a', 'b', 'c'], options);
    expect(lines(side.render(50))).toHaveLength(3);
    const side2 = new SideBySide(column(['a', 'b', 'c']), () => ['only'], options);
    expect(lines(side2.render(50))).toHaveLength(3);
});

test('below the minimum width the columns stack, at full width', () => {
    const left = column(['one']);
    const side = new SideBySide(left, (width) => [`right ${width}`], options);
    expect(lines(side.render(30))).toEqual(['one', '', 'right 30']);
    expect(left.width).toBe(30);
});

test('clipping and padding count printed columns, not bytes', () => {
    const styled = '\x1b[31mabcdef\x1b[39m';
    expect(visibleWidth(clip(styled, 3))).toBe(3);
    expect(clip(styled, 9)).toBe(styled);
    expect(visibleWidth(pad(styled, 9))).toBe(9);
    expect(clip(styled, 0)).toBe('');
});
