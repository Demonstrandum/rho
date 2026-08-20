// tetris-style pi logo animation, ported from pi.dev's home-inline.js.
// renders as a custom overlay via ctx.ui.custom().
// trigger with /logo to play the animation.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ansiFg, parseHex, type Rgb, RESET } from './lib/utils';

// board dimensions (the animation uses an 8x9 grid, visible area is centered 4x4)
const BOARD_W = 8;
const BOARD_H = 9;

// colors from pi.dev (hex)
const COLORS: Record<string, Rgb> = {
    cyan:   parseHex('#4B607C')!,   // top piece (tidal blue)
    red:    parseHex('#8F4632')!,   // left piece (terracotta)
    green:  parseHex('#A3A473')!,   // right piece (sage)
    orange: parseHex('#D4904E')!,   // base piece (sunkissed)
    flash:  parseHex('#fff5b4')!,   // line clear flash
    white:  parseHex('#ffffff')!,   // settled logo
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

// animation sequence and timing (frames at 18 FPS)
const FPS = 18;
const FRAME_MS = 1000 / FPS;

interface SequenceStep {
    piece: Piece;
    duration: number;  // frames
    holdAfter: number; // frames
}

const SEQUENCE: SequenceStep[] = [
    { piece: BASE,  duration: 91, holdAfter: 11 },
    { piece: LEFT,  duration: 91, holdAfter: 11 },
    { piece: TOP,   duration: 91, holdAfter: 11 },
    { piece: RIGHT, duration: 91, holdAfter: 49 },
];

const TIMING = {
    initialHold: 28,       // frames before first drop
    clearFlashCount: 5,    // number of flashes
    clearFlashStep: 35,    // frames per flash
    postClearHold: 49,     // frames after clear
    postDropHold: 154,     // frames before settling to white
};

// final logo cell positions (after line clear)
const FINAL_LOGO = ['3:2', '3:3', '3:4', '4:2', '4:4', '5:2', '5:3', '5:5', '6:2', '6:5'];

// easing
function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

// cell key helper
function cellKey(y: number, x: number): string {
    return `${y}:${x}`;
}

// animation state
interface AnimState {
    frame: number;
    settled: Map<string, string>;       // cellKey -> color
    active: { piece: Piece; x: number; y: number } | null;
    phase: 'initial' | 'dropping' | 'hold' | 'flash' | 'postFlash' | 'settle' | 'done';
    stepIndex: number;
    phaseFrame: number;
    flashCount: number;
    showFlash: boolean;
    whiteOut: boolean;
}

function createState(): AnimState {
    return {
        frame: 0,
        settled: new Map(),
        active: null,
        phase: 'initial',
        stepIndex: 0,
        phaseFrame: 0,
        flashCount: 0,
        showFlash: false,
        whiteOut: false,
    };
}

// advance the animation by one frame
function tick(state: AnimState): boolean {
    state.frame++;
    state.phaseFrame++;

    switch (state.phase) {
        case 'initial':
            if (state.phaseFrame >= TIMING.initialHold) {
                startDrop(state);
            }
            break;

        case 'dropping': {
            const step = SEQUENCE[state.stepIndex];
            const progress = Math.min(1, state.phaseFrame / step.duration);
            const eased = easeOutCubic(progress);
            const piece = step.piece;
            const y = piece.startY + (piece.targetY - piece.startY) * eased;
            state.active = { piece, x: piece.targetX, y };

            if (progress >= 1) {
                // lock piece
                for (const [dy, dx] of piece.cells) {
                    state.settled.set(cellKey(piece.targetY + dy, piece.targetX + dx), piece.color);
                }
                state.active = null;
                state.phase = 'hold';
                state.phaseFrame = 0;
            }
            break;
        }

        case 'hold': {
            const step = SEQUENCE[state.stepIndex];
            if (state.phaseFrame >= step.holdAfter) {
                state.stepIndex++;
                if (state.stepIndex >= SEQUENCE.length) {
                    // all pieces dropped, start flash
                    state.phase = 'flash';
                    state.phaseFrame = 0;
                    state.flashCount = 0;
                    state.showFlash = true;
                } else {
                    startDrop(state);
                }
            }
            break;
        }

        case 'flash':
            if (state.phaseFrame >= TIMING.clearFlashStep) {
                state.phaseFrame = 0;
                state.showFlash = !state.showFlash;
                if (!state.showFlash) {
                    state.flashCount++;
                    if (state.flashCount >= TIMING.clearFlashCount) {
                        // clear the base row
                        for (let x = 1; x <= 6; x++) {
                            state.settled.delete(cellKey(6, x));
                        }
                        state.phase = 'postFlash';
                        state.phaseFrame = 0;
                    }
                }
            }
            break;

        case 'postFlash':
            if (state.phaseFrame >= TIMING.postClearHold) {
                state.phase = 'settle';
                state.phaseFrame = 0;
            }
            break;

        case 'settle':
            if (state.phaseFrame >= TIMING.postDropHold) {
                state.whiteOut = true;
                state.phase = 'done';
            }
            break;

        case 'done':
            return false; // animation complete
    }

    return true;
}

function startDrop(state: AnimState): void {
    state.phase = 'dropping';
    state.phaseFrame = 0;
    const piece = SEQUENCE[state.stepIndex].piece;
    state.active = { piece, x: piece.startX, y: piece.startY };
}

// render the board to lines of styled text
function render(state: AnimState): string[] {
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
        for (let x = 1; x <= 6; x++) {
            if (grid[6][x]) {
                grid[6][x] = 'flash';
            }
        }
    }

    // white out for final state
    if (state.whiteOut) {
        // clear and draw only final logo
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

    // render to styled lines using full blocks
    const lines: string[] = [];
    for (let y = 0; y < BOARD_H; y++) {
        let line = '';
        for (let x = 0; x < BOARD_W; x++) {
            const color = grid[y][x];
            if (color) {
                const rgb = COLORS[color] || COLORS.white;
                line += ansiFg(rgb) + '██' + RESET;
            } else {
                line += '  ';
            }
        }
        lines.push(line);
    }

    return lines;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand('logo', {
        description: 'play the tetris-style pi logo animation',
        handler: async (_args, ctx) => {
            if (ctx.mode !== 'tui') {
                ctx.ui.notify('logo animation requires TUI mode', 'warning');
                return;
            }

            const state = createState();

            // use ctx.ui.custom to display the animation as an overlay
            await ctx.ui.custom<void>((tui, theme, _kb, done) => {
                let disposed = false;
                const timer = setInterval(() => {
                    if (disposed) return;
                    const cont = tick(state);
                    tui.requestRender();
                    if (!cont) {
                        clearInterval(timer);
                        // keep showing for a moment, then close
                        setTimeout(() => {
                            if (!disposed) {
                                disposed = true;
                                done();
                            }
                        }, 1000);
                    }
                }, FRAME_MS);

                return {
                    dispose() {
                        disposed = true;
                        clearInterval(timer);
                    },
                    invalidate() {},
                    render(_width: number): string[] {
                        const lines = render(state);
                        // add a dim hint at the bottom
                        return [
                            '',
                            ...lines,
                            '',
                            theme.fg('dim', '  pi · any key to close'),
                        ];
                    },
                    handleInput(data: string): boolean {
                        // any key closes the overlay
                        if (data.length > 0) {
                            disposed = true;
                            clearInterval(timer);
                            done();
                            return true;
                        }
                        return false;
                    },
                };
            });
        },
    });
}
