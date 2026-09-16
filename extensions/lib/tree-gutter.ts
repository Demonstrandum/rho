// the two columns pi's tree view spends on a cursor mark, reused for the
// selection band and for relative row numbers.
//
// pi renders each row as `cursor + prefix + content`, where cursor is "› " on
// the row under the cursor and two spaces everywhere else. rewriting those two
// visible columns is enough to show what is selected and how far away a row
// is, and it leaves the rest of the row, its connectors, its colours and its
// horizontal clipping, exactly as pi drew it.
//
// numbers stop at a branch point. a count is a promise that `5k` lands on the
// row the number is on, and past a branch the rows shown are not the rows the
// cursor walks, so past it the gutter is blank. that makes the branch point
// visible as the place the numbers run out.

import { spliceVisible } from './text';

export const GUTTER = 2;

const DIM = '\x1b[2m';
const RESET = '\x1b[22m';

export type RowMark =
    | { readonly kind: 'cursor' }
    | { readonly kind: 'selected' }
    | { readonly kind: 'distance'; readonly rows: number }
    | { readonly kind: 'blank' };

/** the two characters a mark occupies, right-aligned as a number is. */
export function gutterText(mark: RowMark): string {
    switch (mark.kind) {
        case 'cursor':
            return '\u203a ';
        case 'selected':
            return '\u2503 ';
        case 'distance':
            return mark.rows > 99 ? '  ' : `${DIM}${String(mark.rows).padStart(2, ' ')}${RESET}`;
        case 'blank':
            return '  ';
    }
}

/** put `mark` in the gutter of a row pi has already rendered. */
export function markRow(line: string, mark: RowMark): string {
    return spliceVisible(line, 0, GUTTER, gutterText(mark));
}

export interface RowState {
    /** row indexes, into the same array `lines` was rendered from. */
    readonly cursor: number;
    readonly selected: ReadonlySet<number>;
    /** rows reachable from the cursor without crossing a branch point. */
    readonly reachable: ReadonlySet<number>;
    /** index of the first rendered row. */
    readonly firstRow: number;
}

function markFor(row: number, state: RowState): RowMark {
    if (row === state.cursor) return { kind: 'cursor' };
    if (state.selected.has(row)) return { kind: 'selected' };
    if (state.reachable.has(row)) return { kind: 'distance', rows: Math.abs(row - state.cursor) };
    return { kind: 'blank' };
}

/**
 * rewrite the gutter of every rendered row.
 *
 * `lines` is what pi's tree list returned: one line per visible row, then its
 * count line. a length that does not match that shape means the renderer
 * changed, and the lines are returned untouched rather than corrupted.
 */
export function markRows(lines: readonly string[], rows: number, state: RowState): string[] {
    if (lines.length !== rows + 1) return [...lines];
    return lines.map((line, at) => (at < rows ? markRow(line, markFor(state.firstRow + at, state)) : line));
}
