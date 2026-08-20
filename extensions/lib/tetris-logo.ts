// tetris-style pi logo animation, faithful port from demo/logo-anim.ts.
// used by startup.ts as one of the intro animation modes.

import type { Rgb } from './utils';

// board dimensions (8x9 grid, same as pi.dev)
const BOARD_W = 8;
const BOARD_H = 9;

// colors for the pieces (before they settle to accent)
export const PIECE_COLORS_DARK: Record<string, Rgb> = {
    cyan:   [0x4B, 0x60, 0x7C],  // top piece
    red:    [0x8F, 0x46, 0x32],  // left piece
    green:  [0xA3, 0xA4, 0x73],  // right piece
    orange: [0xD4, 0x90, 0x4E],  // base piece
    flash:  [0xFF, 0xF5, 0xB4],  // line clear flash
};

export const PIECE_COLORS_LIGHT: Record<string, Rgb> = {
    cyan:   [0x2D, 0x4A, 0x6E],
    red:    [0xA0, 0x38, 0x20],
    green:  [0x6B, 0x7A, 0x30],
    orange: [0xC0, 0x6A, 0x20],
    flash:  [0xFF, 0xD7, 0x00],
};

// piece definitions: color, cells (row, col offsets), start/target positions
interface Piece {
    color: string;
    cells: [number, number][];
    startX: number;
    startY: number;
    targetX: number;
    targetY: number;
}

const BASE: Piece = {
    color: 'orange',
    cells: [[0, 0], [0, 1], [0, 2], [0, 3]],
    startX: 1,
    startY: -2,
    targetX: 1,
    targetY: 6,
};

const LEFT: Piece = {
    color: 'red',
    cells: [[0, 0], [1, 0], [1, 1], [2, 0]],
    startX: 0,
    startY: -3,
    targetX: 2,
    targetY: 3,
};

const TOP: Piece = {
    color: 'cyan',
    cells: [[0, 0], [0, 1], [0, 2], [1, 2]],
    startX: 2,
    startY: -2,
    targetX: 2,
    targetY: 2,
};

const RIGHT: Piece = {
    color: 'green',
    cells: [[0, 0], [1, 0], [2, 0], [2, 1]],
    startX: 5,
    startY: -3,
    targetX: 5,
    targetY: 4,
};

// timing ratios (sum to 1.0)
const RATIO = {
    initialHold:  0.07,
    dropPhase:    0.55,
    flashPhase:   0.18,
    postClear:    0.05,
    settle:       0.15,
};

const DROP_MOTION_PARTS = 4;
const DROP_HOLD_PARTS = 1;
const LAST_HOLD_PARTS = 2;
const TOTAL_DROP_PARTS = 4 * DROP_MOTION_PARTS + 3 * DROP_HOLD_PARTS + LAST_HOLD_PARTS;
const FLASH_COUNT = 4;

const SEQUENCE = [BASE, LEFT, TOP, RIGHT];

// final logo cell positions (after line clear) - maps to the pi glyph
const FINAL_LOGO = ['3:2', '3:3', '3:4', '4:2', '4:4', '5:2', '5:3', '5:5', '6:2', '6:5'];

function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

function cellKey(y: number, x: number): string {
    return `${y}:${x}`;
}

export interface TetrisState {
    totalMs: number;
    settled: Map<string, string>;
    active: { piece: Piece; x: number; y: number } | null;
    phase: 'initial' | 'dropping' | 'hold' | 'flash' | 'postFlash' | 'settle' | 'done';
    stepIndex: number;
    phaseStart: number;
    showFlash: boolean;
    whiteOut: boolean;
    timing: {
        initialHold: number;
        dropDuration: number;
        dropHold: number;
        lastHold: number;
        flashStep: number;
        postClearHold: number;
        postDropHold: number;
    };
}

export function createTetrisState(totalMs: number): TetrisState {
    const dropPhaseMs = totalMs * RATIO.dropPhase;
    const partMs = dropPhaseMs / TOTAL_DROP_PARTS;

    return {
        totalMs,
        settled: new Map(),
        active: null,
        phase: 'initial',
        stepIndex: 0,
        phaseStart: 0,
        showFlash: false,
        whiteOut: false,
        timing: {
            initialHold: totalMs * RATIO.initialHold,
            dropDuration: partMs * DROP_MOTION_PARTS,
            dropHold: partMs * DROP_HOLD_PARTS,
            lastHold: partMs * LAST_HOLD_PARTS,
            flashStep: (totalMs * RATIO.flashPhase) / (FLASH_COUNT * 2),
            postClearHold: totalMs * RATIO.postClear,
            postDropHold: totalMs * RATIO.settle,
        },
    };
}

function startDrop(state: TetrisState, elapsed: number): void {
    const piece = SEQUENCE[state.stepIndex];
    state.active = { piece, x: piece.startX, y: piece.startY };
    state.phase = 'dropping';
    state.phaseStart = elapsed;
}

export function tickTetris(state: TetrisState, elapsed: number): boolean {
    const phaseElapsed = elapsed - state.phaseStart;
    const { timing } = state;

    switch (state.phase) {
        case 'initial':
            if (phaseElapsed >= timing.initialHold) {
                startDrop(state, elapsed);
            }
            break;

        case 'dropping': {
            const piece = SEQUENCE[state.stepIndex];
            const progress = Math.min(1, phaseElapsed / timing.dropDuration);
            const eased = easeOutCubic(progress);
            const y = piece.startY + (piece.targetY - piece.startY) * eased;
            state.active = { piece, x: piece.targetX, y };

            if (progress >= 1) {
                // lock piece
                for (const [dy, dx] of piece.cells) {
                    state.settled.set(cellKey(piece.targetY + dy, piece.targetX + dx), piece.color);
                }
                state.active = null;
                state.phase = 'hold';
                state.phaseStart = elapsed;
            }
            break;
        }

        case 'hold': {
            const holdDur = state.stepIndex === SEQUENCE.length - 1 ? timing.lastHold : timing.dropHold;
            if (phaseElapsed >= holdDur) {
                state.stepIndex++;
                if (state.stepIndex >= SEQUENCE.length) {
                    state.phase = 'flash';
                    state.phaseStart = elapsed;
                    state.showFlash = true;
                } else {
                    startDrop(state, elapsed);
                }
            }
            break;
        }

        case 'flash': {
            const flashPhase = Math.floor(phaseElapsed / timing.flashStep);
            state.showFlash = flashPhase % 2 === 0;
            if (flashPhase >= FLASH_COUNT * 2) {
                // clear the base row
                for (let x = 1; x <= 6; x++) {
                    state.settled.delete(cellKey(6, x));
                }
                state.phase = 'postFlash';
                state.phaseStart = elapsed;
            }
            break;
        }

        case 'postFlash':
            if (phaseElapsed >= timing.postClearHold) {
                state.phase = 'settle';
                state.phaseStart = elapsed;
            }
            break;

        case 'settle':
            if (phaseElapsed >= timing.postDropHold) {
                state.whiteOut = true;
                state.phase = 'done';
            }
            break;

        case 'done':
            return false;
    }

    return true;
}

// build the 8x9 grid for the current state
function buildGrid(state: TetrisState): (string | null)[][] {
    const grid: (string | null)[][] = [];
    for (let y = 0; y < BOARD_H; y++) {
        grid[y] = new Array(BOARD_W).fill(null);
    }

    // place settled cells
    for (const [key, color] of state.settled) {
        const [y, x] = key.split(':').map(Number);
        if (y >= 0 && y < BOARD_H && x >= 0 && x < BOARD_W) {
            grid[y][x] = color;
        }
    }

    // place active piece
    if (state.active) {
        const { piece, x: px, y: py } = state.active;
        for (const [dy, dx] of piece.cells) {
            const y = Math.floor(py + dy);
            const x = px + dx;
            if (y >= 0 && y < BOARD_H && x >= 0 && x < BOARD_W) {
                grid[y][x] = piece.color;
            }
        }
    }

    // flash effect on row 6
    if (state.phase === 'flash' && state.showFlash) {
        for (let x = 0; x < BOARD_W; x++) {
            if (grid[6][x]) {
                grid[6][x] = 'flash';
            }
        }
    }

    // white out for final state
    if (state.whiteOut) {
        for (let y = 0; y < BOARD_H; y++) {
            for (let x = 0; x < BOARD_W; x++) {
                grid[y][x] = null;
            }
        }
        for (const key of FINAL_LOGO) {
            const [y, x] = key.split(':').map(Number);
            grid[y][x] = 'white';
        }
    }

    return grid;
}

/**
 * Get the visual state of a glyph cell during tetris animation.
 * gr, gc are glyph coordinates (0-3).
 * Returns: 'empty' | 'flash' | color name | 'white'
 */
export function getTetrisCellState(
    state: TetrisState,
    gr: number,
    gc: number,
): 'empty' | 'flash' | 'white' | string {
    const grid = buildGrid(state);

    // map glyph to board: glyph[0..3][0..3] -> board[3..6][2..5]
    const boardY = gr + 3;
    const boardX = gc + 2;

    const color = grid[boardY]?.[boardX];
    if (!color) return 'empty';
    return color;
}

/**
 * Check if tetris intro is complete (for transitioning to shimmer).
 */
export function isTetrisDone(state: TetrisState): boolean {
    return state.phase === 'done';
}
