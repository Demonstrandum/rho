// tetris-style pi logo animation, ported from pi.dev's home-inline.js.
// run with: bun run demo/logo-anim.ts

// standalone demo - inline utils

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | undefined {
    const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) return undefined;
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function ansiFg(rgb: Rgb): string {
    return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

const RESET = '\x1b[0m';

// board dimensions (the animation uses an 8x9 grid, visible area is centered 4x4)
const BOARD_W = 8;
const BOARD_H = 9;

// colors from pi.dev (hex) - dark mode
const COLORS_DARK: Record<string, Rgb> = {
    cyan:   parseHex('#4B607C')!,   // top piece (tidal blue)
    red:    parseHex('#8F4632')!,   // left piece (terracotta)
    green:  parseHex('#A3A473')!,   // right piece (sage)
    orange: parseHex('#D4904E')!,   // base piece (sunkissed)
    flash:  parseHex('#fff5b4')!,   // line clear flash
    white:  parseHex('#ffffff')!,   // settled logo
};

// colors for light mode - more saturated/darker to show on light bg
const COLORS_LIGHT: Record<string, Rgb> = {
    cyan:   parseHex('#2D4A6E')!,   // darker tidal blue
    red:    parseHex('#A03820')!,   // darker terracotta  
    green:  parseHex('#6B7A30')!,   // darker sage
    orange: parseHex('#C06A20')!,   // darker sunkissed
    flash:  parseHex('#FFD700')!,   // gold flash
    white:  parseHex('#1a1a1a')!,   // dark gray (inverted)
};

// detect light/dark mode: --light / --dark flags, or COLORFGBG env, or default light
function isLightMode(): boolean {
    if (process.argv.includes('--light')) return true;
    if (process.argv.includes('--dark')) return false;
    const colorfgbg = process.env.COLORFGBG;
    if (colorfgbg) {
        // format is "fg;bg" - bg > 8 typically means light
        const parts = colorfgbg.split(';');
        const bg = parseInt(parts[parts.length - 1], 10);
        return bg > 8 || bg === 7;
    }
    return true;
}

const COLORS = isLightMode() ? COLORS_LIGHT : COLORS_DARK;

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

// animation timing - all derived from TOTAL_MS
const TOTAL_MS = 2700;  // adjust this one value to change overall speed
const FPS = 60;
const FRAME_MS = 1000 / FPS;

// timing ratios (sum to 1.0)
const RATIO = {
    initialHold:  0.07,   // pause before first drop
    dropPhase:    0.55,   // all 4 drops + inter-drop holds
    flashPhase:   0.18,   // line clear flashing
    postClear:    0.05,   // pause after clear
    settle:       0.15,   // pause before white-out
};

// within dropPhase: each drop is 4 parts motion + 1 part hold (last drop gets 2 parts hold)
const DROP_MOTION_PARTS = 4;
const DROP_HOLD_PARTS = 1;
const LAST_HOLD_PARTS = 2;
const TOTAL_DROP_PARTS = 4 * DROP_MOTION_PARTS + 3 * DROP_HOLD_PARTS + LAST_HOLD_PARTS; // 21

const dropPhaseMs = TOTAL_MS * RATIO.dropPhase;
const partMs = dropPhaseMs / TOTAL_DROP_PARTS;
const dropDuration = partMs * DROP_MOTION_PARTS;
const dropHold = partMs * DROP_HOLD_PARTS;
const lastHold = partMs * LAST_HOLD_PARTS;

interface SequenceStep {
    piece: Piece;
    duration: number;  // ms
    holdAfter: number; // ms
}

const SEQUENCE: SequenceStep[] = [
    { piece: BASE,  duration: dropDuration, holdAfter: dropHold },
    { piece: LEFT,  duration: dropDuration, holdAfter: dropHold },
    { piece: TOP,   duration: dropDuration, holdAfter: dropHold },
    { piece: RIGHT, duration: dropDuration, holdAfter: lastHold },
];

const TIMING = {
    initialHold:    TOTAL_MS * RATIO.initialHold,
    clearFlashCount: 4,
    clearFlashStep: (TOTAL_MS * RATIO.flashPhase) / 8,  // 4 flashes × 2 states
    postClearHold:  TOTAL_MS * RATIO.postClear,
    postDropHold:   TOTAL_MS * RATIO.settle,
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
    elapsed: number;                    // total ms elapsed
    settled: Map<string, string>;       // cellKey -> color
    active: { piece: Piece; x: number; y: number } | null;
    phase: 'initial' | 'dropping' | 'hold' | 'flash' | 'postFlash' | 'settle' | 'done';
    stepIndex: number;
    phaseStart: number;                 // ms when phase started
    flashCount: number;
    showFlash: boolean;
    whiteOut: boolean;
}

function createState(): AnimState {
    return {
        elapsed: 0,
        settled: new Map(),
        active: null,
        phase: 'initial',
        stepIndex: 0,
        phaseStart: 0,
        flashCount: 0,
        showFlash: false,
        whiteOut: false,
    };
}

// advance the animation by dt milliseconds
function tick(state: AnimState, dt: number): boolean {
    state.elapsed += dt;
    const phaseElapsed = state.elapsed - state.phaseStart;

    switch (state.phase) {
        case 'initial':
            if (phaseElapsed >= TIMING.initialHold) {
                startDrop(state);
            }
            break;

        case 'dropping': {
            const step = SEQUENCE[state.stepIndex];
            const progress = Math.min(1, phaseElapsed / step.duration);
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
                state.phaseStart = state.elapsed;
            }
            break;
        }

        case 'hold': {
            const step = SEQUENCE[state.stepIndex];
            if (phaseElapsed >= step.holdAfter) {
                state.stepIndex++;
                if (state.stepIndex >= SEQUENCE.length) {
                    state.phase = 'flash';
                    state.phaseStart = state.elapsed;
                    state.flashCount = 0;
                    state.showFlash = true;
                } else {
                    startDrop(state);
                }
            }
            break;
        }

        case 'flash': {
            const flashPhase = Math.floor(phaseElapsed / TIMING.clearFlashStep);
            state.showFlash = flashPhase % 2 === 0;
            if (flashPhase >= TIMING.clearFlashCount * 2) {
                // clear the base row
                for (let x = 1; x <= 6; x++) {
                    state.settled.delete(cellKey(6, x));
                }
                state.phase = 'postFlash';
                state.phaseStart = state.elapsed;
            }
            break;
        }

        case 'postFlash':
            if (phaseElapsed >= TIMING.postClearHold) {
                state.phase = 'settle';
                state.phaseStart = state.elapsed;
            }
            break;

        case 'settle':
            if (phaseElapsed >= TIMING.postDropHold) {
                state.whiteOut = true;
                state.phase = 'done';
            }
            break;

        case 'done':
            return false;
    }

    return true;
}

function startDrop(state: AnimState): void {
    state.phase = 'dropping';
    state.phaseStart = state.elapsed;
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

// ANSI helpers for terminal animation
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const MOVE_HOME = '\x1b[H';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const state = createState();

    // hide cursor and clear screen
    process.stdout.write(HIDE_CURSOR + CLEAR_SCREEN);

    // handle ctrl+c gracefully
    process.on('SIGINT', () => {
        process.stdout.write(SHOW_CURSOR + '\n');
        process.exit(0);
    });

    // animation loop
    while (true) {
        const lines = render(state);
        process.stdout.write(MOVE_HOME + lines.join('\n') + '\n');

        const cont = tick(state, FRAME_MS);
        if (!cont) {
            // hold final frame for a moment
            await sleep(1000);
            break;
        }

        await sleep(FRAME_MS);
    }

    // show cursor and exit
    process.stdout.write(SHOW_CURSOR);
}

main();
