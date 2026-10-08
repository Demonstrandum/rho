import { test, expect } from 'bun:test';
import { Markdown } from '@earendil-works/pi-tui';
import '../extensions/halfblock-boxes';
import { config } from '../extensions/lib/core/config';

// since pi 1.0.0 a user message is a bare Markdown that pads and colours itself,
// so the half-block patch on Box alone left it with flat padding rows.
// the Markdown here is built the way UserMessageComponent builds it; the
// component itself needs pi's global theme, which other test files read.

const markdownTheme = new Proxy({}, { get: () => (s: string) => s }) as never;
const userBg = (s: string): string => `\x1b[48;2;52;53;65m${s}\x1b[49m`;

test.if(config.render.halfBlocks)('a user message opens and closes on half blocks', () => {
    const lines = new Markdown('hello', 1, 1, markdownTheme, { bgColor: userBg }).render(40);
    expect(lines[0]).toBe(`\x1b[38;2;52;53;65m${'\u2584'.repeat(40)}\x1b[39m`);
    expect(lines.at(-1)).toBe(`\x1b[38;2;52;53;65m${'\u2580'.repeat(40)}\x1b[39m`);
    expect(lines.some((line) => line.includes('hello'))).toBe(true);
});

test('a markdown with no background keeps its padding rows blank', () => {
    const lines = new Markdown('hello', 1, 1, markdownTheme).render(20);
    expect(lines[0]!.trim()).toBe('');
    expect(lines.at(-1)!.trim()).toBe('');
});
