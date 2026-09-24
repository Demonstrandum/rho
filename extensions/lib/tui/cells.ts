// a rendered terminal line as a row of cells, and back.
//
// a painter that decides per column (a star in this blank cell, a tint under
// that one) needs to know, for each column, what is printed there and in which
// colours. a rendered line only states that as a stream of SGR changes, so it
// is read into cells, the cells are changed, and the row is written out again.
//
// the style of a cell is the SGR state in force when it was printed. colours
// keep their original parameters unless they are truecolor, which are read
// into rgb so a painter can blend them. every other attribute (bold, reverse,
// an underline style, an underline colour) is kept as the parameter text that
// set it, so a round trip leaves it as it was.
//
// escapes that are not SGR (a hyperlink, pi's cursor marker, a shell
// integration mark) print nothing; each rides on the cell it preceded, or on
// the row's tail after the last cell.

import { visibleWidth } from '@earendil-works/pi-tui';
import type { Rgb } from '../core/utils';

export type Colour =
    | { kind: 'rgb'; rgb: Rgb }
    /** any other colour, as the parameters that set it: `31`, `38;5;200` */
    | { kind: 'code'; params: string };

export interface Style {
    fg?: Colour;
    bg?: Colour;
    /** every other attribute in force, as the parameter that set it */
    attrs: string[];
}

export interface Cell {
    /** one grapheme */
    text: string;
    /** columns it occupies: 1, or 2 for a wide character */
    width: number;
    style: Style;
    /** zero-width escapes printed before this cell */
    lead: string;
}

export interface Row {
    cells: Cell[];
    tail: string;
}

const ESCAPE = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/y;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function colour(params: string[]): Colour {
    if (params[1] === '2' && params.length >= 5) {
        return { kind: 'rgb', rgb: [Number(params[2]), Number(params[3]), Number(params[4])] };
    }
    return { kind: 'code', params: params.join(';') };
}

// which attributes an SGR "off" parameter clears, by the "on" parameter's
// leading number.
const CLEARS: Readonly<Record<string, readonly string[]>> = {
    '22': ['1', '2'],
    '23': ['3'],
    '24': ['4', '21'],
    '25': ['5', '6'],
    '27': ['7'],
    '28': ['8'],
    '29': ['9'],
    '55': ['53'],
    '59': ['58'],
};

function head(attr: string): string {
    return attr.split(/[;:]/, 1)[0]!;
}

function without(attrs: string[], heads: readonly string[]): string[] {
    return attrs.filter((a) => !heads.includes(head(a)));
}

function applySgr(style: Style, body: string): Style {
    const params = body === '' ? ['0'] : body.split(';');
    let next: Style = { fg: style.fg, bg: style.bg, attrs: [...style.attrs] };
    for (let i = 0; i < params.length; i++) {
        const p = params[i]!;
        const n = p.includes(':') ? NaN : Number(p);
        if (p === '' || n === 0) {
            next = { attrs: [] };
        } else if (n === 38 || n === 48 || n === 58) {
            const size = params[i + 1] === '2' ? 5 : params[i + 1] === '5' ? 3 : 1;
            const taken = params.slice(i, i + size);
            i += size - 1;
            if (n === 38) next.fg = colour(taken);
            else if (n === 48) next.bg = colour(taken);
            else next.attrs = [...without(next.attrs, ['58']), taken.join(';')];
        } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
            next.fg = { kind: 'code', params: p };
        } else if (n === 39) {
            next.fg = undefined;
        } else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
            next.bg = { kind: 'code', params: p };
        } else if (n === 49) {
            next.bg = undefined;
        } else if (CLEARS[p] !== undefined) {
            next.attrs = without(next.attrs, CLEARS[p]!);
        } else if (p === '4:0') {
            next.attrs = without(next.attrs, ['4']);
        } else {
            const h = head(p);
            next.attrs = [...without(next.attrs, [h]), p];
        }
    }
    return next;
}

export function readRow(line: string): Row {
    const cells: Cell[] = [];
    let style: Style = { attrs: [] };
    let lead = '';
    let text = '';

    const flushText = () => {
        if (text === '') return;
        for (const { segment } of segmenter.segment(text)) {
            const width = segment.length === 1 && segment >= ' ' && segment <= '~' ? 1 : visibleWidth(segment);
            if (width === 0 && cells.length > 0 && lead === '') {
                cells[cells.length - 1]!.text += segment;
                continue;
            }
            cells.push({ text: segment, width, style, lead });
            lead = '';
        }
        text = '';
    };

    let i = 0;
    while (i < line.length) {
        if (line.charCodeAt(i) === 0x1b) {
            ESCAPE.lastIndex = i;
            const m = ESCAPE.exec(line);
            if (m !== null) {
                flushText();
                if (m[1] !== undefined) style = applySgr(style, m[1]);
                else lead += m[0];
                i += m[0].length;
                continue;
            }
        }
        text += line[i];
        i++;
    }
    flushText();
    return { cells, tail: lead };
}

function colourParams(c: Colour, base: 38 | 48): string {
    if (c.kind === 'code') return c.params;
    return `${base};2;${c.rgb[0]};${c.rgb[1]};${c.rgb[2]}`;
}

function sgrOf(style: Style): string {
    const parts = ['0', ...style.attrs];
    if (style.fg !== undefined) parts.push(colourParams(style.fg, 38));
    if (style.bg !== undefined) parts.push(colourParams(style.bg, 48));
    return `\x1b[${parts.join(';')}m`;
}

export function writeRow(row: Row): string {
    let out = '';
    let current = '\x1b[0m';
    for (const cell of row.cells) {
        out += cell.lead;
        const sgr = sgrOf(cell.style);
        if (sgr !== current) {
            out += sgr;
            current = sgr;
        }
        out += cell.text;
    }
    if (current !== '\x1b[0m') out += '\x1b[0m';
    return out + row.tail;
}

export function rgbOf(c: Colour | undefined): Rgb | undefined {
    return c?.kind === 'rgb' ? c.rgb : undefined;
}
