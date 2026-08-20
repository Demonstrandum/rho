// tetris-style intro animation for the pi glyph.
// drops tetromino-like pieces that assemble into the pi shape, with flash effect.
// after the animation completes, the glyph is fully revealed for shimmer to run over.

import type { Rgb } from './utils';

// the pi glyph shape (same as startup.ts uses)
const GLYPH: readonly number[][] = [
    [1, 1, 1, 0],
    [1, 0, 1, 0],
    [1, 1, 0, 1],
    [1, 0, 0, 1],
];

const GLYPH_H = GLYPH.length;
const GLYPH_W = Math.max(...GLYPH.map((row) => row.length));

// piece definitions for the drop animation.
// each piece reveals a set of glyph cells when it locks.
interface Piece {
    color: string;
    // cells in glyph coordinates [row, col] that this piece reveals
    cells: [number, number][];
    // animation: start off-screen (negative), drop to final row
    startRow: number;
    targetRow: number;
}

// the top bar drops first, then left leg, then right leg.
// this order gives the visual of "pi" assembling from top to bottom.
const PIECES: Piece[] = [
    // top bar (cyan) - the horizontal stroke
    { color: 'cyan', cells: [[0, 0], [0, 1], [0, 2]], startRow: -1, targetRow: 0 },
    // left leg (red) - the left vertical with the hook
    { color: 'red', cells: [[1, 0], [2, 0], [2, 1], [3, 0]], startRow: -2, targetRow: 1 },
    // right leg (green) - the right vertical
    { color: 'green', cells: [[1, 2], [2, 3], [3, 3]], startRow: -2, targetRow: 1 },
];

// colors for the dropping pieces (before they settle to accent)
export const PIECE_COLORS_DARK: Record<string, Rgb> = {
    cyan:   [0x4B, 0x60, 0x7C],
    red:    [0x8F, 0x46, 0x32],
    green:  [0xA3, 0xA4, 0x73],
    flash:  [0xFF, 0xF5, 0xB4],
};

export const PIECE_COLORS_LIGHT: Record<string, Rgb> = {
    cyan:   [0x2D, 0x4A, 0x6E],
    red:    [0xA0, 0x38, 0x20],
    green:  [0x6B, 0x7A, 0x30],
    flash:  [0xFF, 0xD7, 0x00],
};

// timing ratios for the tetris intro (sum to 1.0)
const RATIO = {
    initialHold:  0.05,
    dropPhase:    0.60,
    flashPhase:   0.15,
    settle:       0.20,
};

const DROP_MOTION_PARTS = 4;
const DROP_HOLD_PARTS = 1;
const LAST_HOLD_PARTS = 2;
const TOTAL_DROP_PARTS = PIECES.length * DROP_MOTION_PARTS + (PIECES.length - 1) * DROP_HOLD_PARTS + LAST_HOLD_PARTS;
const FLASH_COUNT = 4;

function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

export interface TetrisState {
    // which glyph cells are revealed (by piece color, for coloring during animation)
    revealed: Map<string, string>;
    // currently dropping piece
    active: { piece: Piece; progress: number } | null;
    phase: 'initial' | 'dropping' | 'hold' | 'flash' | 'settle' | 'done';
    pieceIndex: number;
    phaseStart: number;
    flashOn: boolean;
    totalMs: number;
    timing: {
        initialEnd: number;
        dropDuration: number;
        dropHold: number;
        lastHold: number;
        flashStep: number;
        flashEnd: number;
        settleEnd: number;
    };
}

function cellKey(r: number, c: number): string {
    return `${r}:${c}`;
}

export function createTetrisState(totalMs: number): TetrisState {
    const dropPhaseMs = totalMs * RATIO.dropPhase;
    const partMs = dropPhaseMs / TOTAL_DROP_PARTS;

    return {
        revealed: new Map(),
        active: null,
        phase: 'initial',
        pieceIndex: 0,
        phaseStart: 0,
        flashOn: false,
        totalMs,
        timing: {
            initialEnd: totalMs * RATIO.initialHold,
            dropDuration: partMs * DROP_MOTION_PARTS,
            dropHold: partMs * DROP_HOLD_PARTS,
            lastHold: partMs * LAST_HOLD_PARTS,
            flashStep: (totalMs * RATIO.flashPhase) / (FLASH_COUNT * 2),
            flashEnd: totalMs * (RATIO.initialHold + RATIO.dropPhase + RATIO.flashPhase),
            settleEnd: totalMs,
        },
    };
}

export function tickTetris(state: TetrisState, elapsed: number): boolean {
    const { timing } = state;

    switch (state.phase) {
        case 'initial':
            if (elapsed >= timing.initialEnd) {
                state.phase = 'dropping';
                state.phaseStart = elapsed;
                state.active = { piece: PIECES[0], progress: 0 };
            }
            break;

        case 'dropping': {
            const piece = PIECES[state.pieceIndex];
            const progress = Math.min(1, (elapsed - state.phaseStart) / timing.dropDuration);
            state.active = { piece, progress };

            if (progress >= 1) {
                // lock piece - reveal its cells
                for (const [r, c] of piece.cells) {
                    state.revealed.set(cellKey(r, c), piece.color);
                }
                state.active = null;
                state.phase = 'hold';
                state.phaseStart = elapsed;
            }
            break;
        }

        case 'hold': {
            const holdDur = state.pieceIndex === PIECES.length - 1 ? timing.lastHold : timing.dropHold;
            if (elapsed - state.phaseStart >= holdDur) {
                state.pieceIndex++;
                if (state.pieceIndex >= PIECES.length) {
                    state.phase = 'flash';
                    state.phaseStart = elapsed;
                    state.flashOn = true;
                } else {
                    state.phase = 'dropping';
                    state.phaseStart = elapsed;
                    state.active = { piece: PIECES[state.pieceIndex], progress: 0 };
                }
            }
            break;
        }

        case 'flash': {
            const flashPhase = Math.floor((elapsed - state.phaseStart) / timing.flashStep);
            state.flashOn = flashPhase % 2 === 0;
            if (elapsed >= timing.flashEnd) {
                state.phase = 'settle';
                state.phaseStart = elapsed;
                state.flashOn = false;
            }
            break;
        }

        case 'settle':
            if (elapsed >= timing.settleEnd) {
                state.phase = 'done';
                return false;
            }
            break;

        case 'done':
            return false;
    }

    return true;
}

/**
 * Get the visual state of a glyph cell during tetris animation.
 * Returns: 'empty' | 'flash' | color name | 'filled'
 */
export function getTetrisCellState(
    state: TetrisState,
    gr: number,
    gc: number,
): 'empty' | 'flash' | 'filled' | string {
    // cell not part of glyph
    if (GLYPH[gr]?.[gc] !== 1) return 'empty';

    const key = cellKey(gr, gc);

    // check if revealed by a locked piece
    const revealedColor = state.revealed.get(key);
    if (revealedColor) {
        // during flash phase, all revealed cells flash
        if (state.phase === 'flash' && state.flashOn) {
            return 'flash';
        }
        // during settle, transition to filled (accent color)
        return state.phase === 'settle' || state.phase === 'done' ? 'filled' : revealedColor;
    }

    // check if being revealed by active dropping piece
    if (state.active) {
        const { piece, progress } = state.active;
        for (const [pr, pc] of piece.cells) {
            if (pr === gr && pc === gc) {
                // reveal cells progressively: top cells first, bottom cells last
                const eased = easeOutCubic(progress);
                // find min and max rows for this piece to compute relative position
                const rows = piece.cells.map(([r]) => r);
                const minRow = Math.min(...rows);
                const maxRow = Math.max(...rows);
                const pieceHeight = maxRow - minRow + 1;
                // cell's relative position within piece (0 = top, 1 = bottom)
                const cellPos = pieceHeight > 1 ? (gr - minRow) / (pieceHeight - 1) : 0;
                // cell becomes visible when eased progress exceeds its position
                // add a small offset so top cell appears immediately when drop starts
                if (eased >= cellPos * 0.8) {
                    return piece.color;
                }
            }
        }
    }

    return 'empty';
}
