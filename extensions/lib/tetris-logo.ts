// the tetris intro: four tetrominoes drop onto an 8x9 board, the bottom row
// fills and clears, and what remains is the pi glyph. ported from pi.dev's
// home-inline.js by way of demo/logo-anim.ts, with the same piece shapes,
// landing squares, easing and phase ratios.
//
// the board is larger than the glyph on both axes: the pieces need rows above
// the glyph to fall through, and the cleared row sits below it. the glyph
// occupies board rows 3..6 and cols 2..5, so once the clear has run the board
// holds exactly the drawn wordmark and the shimmer can take over in place.
//
// in a subdirectory so pi's extension auto-discovery (top-level *.ts only)
// does not try to load it as an extension.

import type { Rgb } from './utils';

// rows 0..2 are the run-up the pieces fall through. the stack lands on rows
// 2..5 over a filled row 6; the clear takes row 6 and the stack falls into
// rows 3..6, which is where the glyph ends up.
export const BOARD_H = 7;

// the row the base piece fills and the clear removes.
const CLEAR_ROW = 6;

// the column the glyph's left edge lands on, which is where the two pieces
// that draw it come down.
const GLYPH_LEFT_COL = 2;

// piece colours, keyed by the name a cell carries in the grid. `flash` is the
// clear highlight, not a piece.
export const PIECE_COLORS_DARK: Record<string, Rgb> = {
    cyan:   [0x4B, 0x60, 0x7C],
    red:    [0x8F, 0x46, 0x32],
    green:  [0xA3, 0xA4, 0x73],
    orange: [0xD4, 0x90, 0x4E],
    flash:  [0xFF, 0xF5, 0xB4],
};

export const PIECE_COLORS_LIGHT: Record<string, Rgb> = {
    cyan:   [0x2D, 0x4A, 0x6E],
    red:    [0xA0, 0x38, 0x20],
    green:  [0x6B, 0x7A, 0x30],
    orange: [0xC0, 0x6A, 0x20],
    flash:  [0xFF, 0xD7, 0x00],
};

interface Piece {
    readonly color: string;
    readonly cells: readonly (readonly [number, number])[];
    readonly startY: number;
    readonly targetX: number;
    readonly targetY: number;
}

const BASE: Piece = {
    color: 'orange',
    cells: [[0, 0], [0, 1], [0, 2], [0, 3]],
    startY: -2,
    targetX: 1,
    targetY: 6,
};

const LEFT: Piece = {
    color: 'red',
    cells: [[0, 0], [1, 0], [1, 1], [2, 0]],
    startY: -3,
    targetX: 2,
    targetY: 3,
};

const TOP: Piece = {
    color: 'cyan',
    cells: [[0, 0], [0, 1], [0, 2], [1, 2]],
    startY: -2,
    targetX: 2,
    targetY: 2,
};

const RIGHT: Piece = {
    color: 'green',
    cells: [[0, 0], [1, 0], [2, 0], [2, 1]],
    startY: -3,
    targetX: 5,
    targetY: 4,
};

const SEQUENCE: readonly Piece[] = [BASE, LEFT, TOP, RIGHT];

// the pieces are wider than the glyph, but only just: the base bar reaches one
// column to its left and the right-hand piece one column to its right. the
// board is cropped to the columns the pieces actually touch, so the block
// carries that one column of margin and no more.
const TOUCHED_COLS = SEQUENCE.flatMap((piece) => piece.cells.map(([, dx]) => piece.targetX + dx));
const WINDOW_LEFT = Math.min(...TOUCHED_COLS);

export const BOARD_W = Math.max(...TOUCHED_COLS) - WINDOW_LEFT + 1;

// where the glyph comes to rest, after the clear and the fall. renderers add
// this to a glyph coordinate to find the board cell, so the handoff to the
// shimmer is exact.
export const BOARD_ROW_OFFSET = 3;
export const BOARD_COL_OFFSET = GLYPH_LEFT_COL - WINDOW_LEFT;

// phase shares of the whole intro. `postClear` is the beat between the stack
// falling into place and the settle starting to blink, so the fall reads as
// its own event rather than running straight into the next flash.
const RATIO = {
    initialHold: 0.06,
    dropPhase:   0.51,
    flashPhase:  0.17,
    postClear:   0.11,
    settle:      0.15,
} as const;

// the shares have to sum to 1: the caller sizes the sequence by scaling them
// against a total, and anything else finishes early or is cut off at the end.
const RATIO_SUM = Object.values(RATIO).reduce((total, share) => total + share, 0);
if (Math.abs(RATIO_SUM - 1) > 1e-9) {
    throw new Error(`tetris phase ratios must sum to 1, got ${RATIO_SUM}`);
}

// inside the drop phase each drop is four parts of motion and one of rest;
// the last drop rests for two so the finished stack reads before it flashes.
const DROP_MOTION_PARTS = 4;
const DROP_HOLD_PARTS = 1;
const LAST_HOLD_PARTS = 2;
const TOTAL_DROP_PARTS =
    SEQUENCE.length * DROP_MOTION_PARTS
    + (SEQUENCE.length - 1) * DROP_HOLD_PARTS
    + LAST_HOLD_PARTS;

// how many times the clear row blinks before it goes, and how many times the
// settled glyph blinks between the piece colours and the accent before it
// keeps the accent. the settle repeats the clear's beat.
const FLASH_COUNT = 4;

function easeOutCubic(t: number): number {
    return 1 - (1 - t) ** 3;
}

type Phase = 'initial' | 'dropping' | 'hold' | 'flash' | 'postFlash' | 'settle' | 'done';

interface Timing {
    readonly initialHold: number;
    readonly dropDuration: number;
    readonly dropHold: number;
    readonly lastHold: number;
    readonly flashStep: number;
    readonly settleStep: number;
    readonly postClearHold: number;
    readonly settleHold: number;
}

export interface TetrisState {
    settled: Map<string, string>;
    active: { piece: Piece; y: number } | null;
    phase: Phase;
    stepIndex: number;
    phaseStart: number;
    showFlash: boolean;
    /** the settle blink is on the accent rather than the piece colours. */
    showLogo: boolean;
    whiteOut: boolean;
    readonly timing: Timing;
}

const cellKey = (y: number, x: number): string => `${y}:${x}`;

// take the filled row out and let everything above it fall one row, the way a
// cleared line does. what is left above the clear is the glyph, so this is the
// step that seats it in its final position.
function clearRow(state: TetrisState): void {
    const fallen = new Map<string, string>();
    for (const [key, color] of state.settled) {
        const [y, x] = key.split(':').map(Number) as [number, number];
        if (y === CLEAR_ROW) {
            continue;
        }
        fallen.set(cellKey(y < CLEAR_ROW ? y + 1 : y, x), color);
    }
    state.settled = fallen;
}

export function createTetrisState(totalMs: number): TetrisState {
    const partMs = (totalMs * RATIO.dropPhase) / TOTAL_DROP_PARTS;
    return {
        settled: new Map(),
        active: null,
        phase: 'initial',
        stepIndex: 0,
        phaseStart: 0,
        showFlash: false,
        showLogo: false,
        whiteOut: false,
        timing: {
            initialHold: totalMs * RATIO.initialHold,
            dropDuration: partMs * DROP_MOTION_PARTS,
            dropHold: partMs * DROP_HOLD_PARTS,
            lastHold: partMs * LAST_HOLD_PARTS,
            flashStep: (totalMs * RATIO.flashPhase) / (FLASH_COUNT * 2),
            settleStep: (totalMs * RATIO.settle) / (FLASH_COUNT * 2),
            postClearHold: totalMs * RATIO.postClear,
            settleHold: totalMs * RATIO.settle,
        },
    };
}

function startDrop(state: TetrisState): void {
    const piece = SEQUENCE[state.stepIndex]!;
    state.phase = 'dropping';
    state.active = { piece, y: piece.startY };
}

// how long the phase that is running now lasts.
function phaseDuration(state: TetrisState): number {
    const { timing } = state;
    switch (state.phase) {
        case 'initial':   return timing.initialHold;
        case 'dropping':  return timing.dropDuration;
        case 'hold':      return state.stepIndex === SEQUENCE.length - 1 ? timing.lastHold : timing.dropHold;
        case 'flash':     return timing.flashStep * FLASH_COUNT * 2;
        case 'postFlash': return timing.postClearHold;
        case 'settle':    return timing.settleHold;
        case 'done':      return 0;
    }
}

// close the running phase and open the next one. phaseStart advances by the
// phase's own length rather than to the caller's clock, so a coarse or uneven
// tick cannot make the sequence drift late.
function advance(state: TetrisState): void {
    state.phaseStart += phaseDuration(state);

    switch (state.phase) {
        case 'initial':
            startDrop(state);
            return;

        case 'dropping': {
            const { piece } = state.active!;
            for (const [dy, dx] of piece.cells) {
                state.settled.set(cellKey(piece.targetY + dy, piece.targetX + dx), piece.color);
            }
            state.active = null;
            state.phase = 'hold';
            return;
        }

        case 'hold':
            state.stepIndex++;
            if (state.stepIndex >= SEQUENCE.length) {
                state.phase = 'flash';
                state.showFlash = true;
            } else {
                startDrop(state);
            }
            return;

        case 'flash':
            clearRow(state);
            state.showFlash = false;
            state.phase = 'postFlash';
            return;

        case 'postFlash':
            state.phase = 'settle';
            return;

        case 'settle':
            state.showLogo = false;
            state.whiteOut = true;
            state.phase = 'done';
            return;

        case 'done':
            return;
    }
}

// advance to elapsed ms. returns false once the sequence has finished. a tick
// may cross several phase boundaries, so it loops until the clock lands inside
// the running phase.
export function tickTetris(state: TetrisState, elapsed: number): boolean {
    while (state.phase !== 'done' && elapsed - state.phaseStart >= phaseDuration(state)) {
        advance(state);
    }
    if (state.phase === 'done') {
        return false;
    }

    if (state.phase === 'dropping') {
        const { piece } = state.active!;
        const progress = Math.min(1, (elapsed - state.phaseStart) / state.timing.dropDuration);
        state.active = {
            piece,
            y: piece.startY + (piece.targetY - piece.startY) * easeOutCubic(progress),
        };
    } else if (state.phase === 'flash') {
        const step = Math.floor((elapsed - state.phaseStart) / state.timing.flashStep);
        state.showFlash = step % 2 === 0;
    } else if (state.phase === 'settle') {
        const step = Math.floor((elapsed - state.phaseStart) / state.timing.settleStep);
        state.showLogo = step % 2 === 0;
    }
    return true;
}

// the board as it stands: a colour name per filled cell, null for empty. the
// name is a key into a PIECE_COLORS table, except `logo`, which the caller
// draws in its own accent so the settled wordmark matches the other intros.
export function tetrisGrid(state: TetrisState): (string | null)[][] {
    const grid: (string | null)[][] = Array.from(
        { length: BOARD_H },
        () => new Array<string | null>(BOARD_W).fill(null),
    );

    // board coordinates run over the uncropped columns; the grid holds the
    // window, so every write shifts by the crop.
    const put = (y: number, x: number, name: string): void => {
        const col = x - WINDOW_LEFT;
        if (y >= 0 && y < BOARD_H && col >= 0 && col < BOARD_W) {
            grid[y]![col] = name;
        }
    };

    // after the clear the settled cells are the glyph and nothing else, so the
    // settle recolours them in place rather than redrawing a second copy.
    for (const [key, color] of state.settled) {
        const [y, x] = key.split(':').map(Number) as [number, number];
        put(y, x, state.whiteOut || state.showLogo ? 'logo' : color);
    }

    if (state.active) {
        const { piece, y: py } = state.active;
        for (const [dy, dx] of piece.cells) {
            put(Math.floor(py + dy), piece.targetX + dx, piece.color);
        }
    }

    // the clear row spans the whole window, so the flash takes all of it.
    if (state.phase === 'flash' && state.showFlash) {
        for (let col = 0; col < BOARD_W; col++) {
            if (grid[CLEAR_ROW]![col]) {
                grid[CLEAR_ROW]![col] = 'flash';
            }
        }
    }

    return grid;
}
