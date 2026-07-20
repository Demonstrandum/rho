import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Rgb } from '../extensions/lib/utils';
import { toFrames, playFrames, parseVerb, formatDuration, formatVerb } from '../extensions/spinner';

const show = (s: string) => s.replaceAll('\x1b', '\\e');

function fakeTheme(roles: Record<string, Rgb>): Theme {
    return {
        getFgAnsi: (color: string) => {
            const rgb = roles[color];
            return rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '\x1b[38;5;12m';
        },
    } as unknown as Theme;
}

function hexRgb(hex: string): Rgb {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// a Theme backed by the real themes/plan9.json: resolve `vars` references and
// treat an empty color ('') as the terminal default fg, exactly as pi does. this
// exercises formatVerb's no-`text`-anchor fallback with the actual palette.
function plan9Theme(): Theme {
    const path = join(import.meta.dir, '..', 'themes', 'plan9.json');
    const { vars, colors } = JSON.parse(readFileSync(path, 'utf8')) as {
        vars: Record<string, string>;
        colors: Record<string, string>;
    };
    const resolve = (role: string): string => {
        let v: string | undefined = colors[role];
        while (v !== undefined && v !== '' && !v.startsWith('#')) v = vars[v];
        return v ?? '';
    };
    return {
        name: 'plan9',
        getFgAnsi: (color: string) => {
            const hex = resolve(color);
            if (hex === '') return '\x1b[39m';
            const [r, g, b] = hexRgb(hex);
            return `\x1b[38;2;${r};${g};${b}m`;
        },
    } as unknown as Theme;
}

test('toFrames splits strings by codepoint, passes arrays through', () => {
    console.log('toFrames("abc"):', JSON.stringify(toFrames('abc')));
    console.log('toFrames("完成"):', JSON.stringify(toFrames('完成')));
    expect(toFrames('abc')).toEqual(['a', 'b', 'c']);
    expect(toFrames('完成')).toEqual(['完', '成']);
    expect(toFrames(['x', 'y'])).toEqual(['x', 'y']);
});

test('playFrames repeats plainly, pulse ping-pongs the interior', () => {
    const frames = ['a', 'b', 'c', 'd'];
    console.log('repeat:', JSON.stringify(playFrames(frames, 'repeat')));
    console.log('pulse: ', JSON.stringify(playFrames(frames, 'pulse')));
    expect(playFrames(frames, 'repeat')).toEqual(['a', 'b', 'c', 'd']);
    expect(playFrames(frames, 'pulse')).toEqual(['a', 'b', 'c', 'd', 'c', 'b']);
    // too short to ping-pong meaningfully -> unchanged.
    expect(playFrames(['a', 'b'], 'pulse')).toEqual(['a', 'b']);
});

test('parseVerb pulls sigil, preposition and trail', () => {
    const cases = [
        'Toiled',
        '[₿] Mined Bitcoin',
        'Solved a Rubiks cube <in only>',
        'xyz <in>, really I did',
    ];
    for (const c of cases) {
        console.log(`parseVerb(${JSON.stringify(c)}):`, JSON.stringify(parseVerb(c)));
    }
    expect(parseVerb('Toiled')).toEqual({ text: 'Toiled', preposition: 'for', trail: '', sigil: '完' });
    expect(parseVerb('[₿] Mined Bitcoin').sigil).toBe('₿');
    expect(parseVerb('Solved a Rubiks cube <in only>')).toEqual({
        text: 'Solved a Rubiks cube', preposition: 'in only', trail: '', sigil: '完',
    });
    // the earlier comma case: trail keeps leading punctuation.
    expect(parseVerb('xyz <in>, really I did').trail).toBe(', really I did');
});

test('formatDuration renders seconds then minutes', () => {
    const rows: [number, string][] = [
        [0, '0s'], [999, '1s'], [12000, '12s'], [65000, '1m 5s'], [3600000, '60m 0s'],
    ];
    for (const [ms, want] of rows) {
        const got = formatDuration(ms);
        console.log(`formatDuration(${ms}) = ${got}`);
        expect(got).toBe(want);
    }
});

test('formatVerb colours sigil brighter than the rest, plain in palette mode', () => {
    const verb = parseVerb('Toiled');

    // dark theme: text lighter than dim -> sigil pushed toward white.
    const dark = fakeTheme({ dim: [100, 100, 100], text: [220, 220, 220] });
    const coloredDark = formatVerb(dark, verb, 12000);
    console.log('formatVerb dark:   ' + coloredDark + '   ' + show(coloredDark));
    // sigil blend([220], white, 0.9) = [252]; rest blend([220], white, 0.45) = [236].
    expect(coloredDark).toContain('\x1b[38;2;252;252;252m完\x1b[0m ');
    expect(coloredDark).toContain('\x1b[38;2;236;236;236mToiled for 12s');

    // light theme: text darker than dim -> sigil pushed toward black.
    const light = fakeTheme({ dim: [150, 150, 150], text: [40, 40, 40] });
    const coloredLight = formatVerb(light, verb, 12000);
    console.log('formatVerb light:  ' + coloredLight + '   ' + show(coloredLight));
    // sigil blend([40], black, 0.9) = [4]; rest blend([40], black, 0.45) = [22].
    expect(coloredLight).toContain('\x1b[38;2;4;4;4m完\x1b[0m ');
    expect(coloredLight).toContain('\x1b[38;2;22;22;22mToiled for 12s');

    // 256-color mode: no rgb anchor to blend from -> keep the theme's own ansi
    // escapes, sigil on `text` and verb on the light `dim` base, not plain fg.
    const palette = {
        getFgAnsi: (color: string) =>
            color === 'text' ? '\x1b[38;5;15m' : color === 'dim' ? '\x1b[38;5;8m' : '\x1b[39m',
    } as unknown as Theme;
    const plain = formatVerb(palette, verb, 12000);
    console.log('formatVerb palette:' + plain + '   ' + show(plain));
    expect(plain).toBe('\x1b[38;5;15m完\x1b[0m \x1b[38;5;8mToiled for 12s\x1b[0m');
});

test('formatVerb on the real plan9 theme: light dim verb, sigil a shade darker', () => {
    const verb = parseVerb('Toiled');
    const out = formatVerb(plan9Theme(), verb, 12000);
    // printed in real ansi (left) so the colours render, and escaped (right) to read.
    console.log('formatVerb plan9:  ' + out + '   ' + show(out));
    // dim = #B0B078 = [176,176,120]; sigil = blend(dim, black, 0.4) = [106,106,72].
    expect(out).toBe('\x1b[38;2;106;106;72m完\x1b[0m \x1b[38;2;176;176;120mToiled for 12s\x1b[0m');
});
