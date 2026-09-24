// twinkling braille stars in the empty input field, and in a tool row while
// its call waits for a result. after codex; the stars themselves are in
// lib/chrome/starfield.ts, and `[starfield]` in rho.toml switches each place.
//
// input field. armed when a session opens, and under `input = "turn"` again
// when a turn ends. the clock starts on the first frame the stars are drawn
// in, and runs on while they are hidden; they go for good at the first
// character in the field, or when `input-seconds` is up, the last second a
// fade with the stars held still. they are drawn only while the field is
// focused, empty, has no menu open, and no turn is running.
//
// tool rows. on the main screen the stars cannot be painted where the row is
// rendered. pi-tui redraws the whole screen, scrollback cleared, when a line
// above the viewport changes, and a row does not know where it sits. so the
// row only marks its lines, with an APC string that prints nothing, and the
// painting happens in TuiMainScreen.render, where the frame is whole and
// `previousViewportTop` says where the viewport starts. a marked line above it
// is written exactly as the frame before wrote it, so the part of a tall row
// that has scrolled off keeps its last stars rather than forcing that redraw.
// the alternate screen writes only the rows in view, so there the row paints
// itself.
//
// the TUI a row holds is pi's reference to the current renderer, a proxy with
// no defineProperty trap, so a patch cannot go on it; it goes on the
// TuiMainScreen prototype instead.
//
// the patches go through lib/tui/render-relay.ts, so /reload swaps the
// painter rather than stacking a second patch on the first. the editor patch
// is installed at session_start, after input-field.ts has laid down the
// field's background at load, since a star needs a truecolor background
// under it.

import {
    CustomEditor,
    ToolExecutionComponent,
    type ExtensionAPI,
    type Theme,
} from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, TuiMainScreen, type TUI } from '@earendil-works/pi-tui';
import { config } from './lib/core/config';
import type { Rgb } from './lib/core/utils';
import { resolveColour } from './lib/tui/colour-spec';
import { readRow, writeRow } from './lib/tui/cells';
import { holdsImage } from './lib/tui/box-edges';
import { paintStars, type Sky } from './lib/chrome/starfield';
import { relay } from './lib/tui/render-relay';
import { FrameTimer } from './lib/tui/frame-timer';
import { editorTui, fieldRows } from './lib/tui/editor-field';

const { input, inputSeconds, tools, color, strength, density } = config.starfield;

const FRAME_MS = 150;
const FADE_MS = 1000;
const FALLBACK_ROLES = ['muted', 'accent', 'border'] as const;

type Phase =
    | { kind: 'unarmed' }
    | { kind: 'waiting' }
    | { kind: 'visible'; since: number }
    | { kind: 'finished' };

let activeTheme: Theme | undefined;
let running = false;
let phase: Phase = { kind: 'unarmed' };

const inputFrames = new FrameTimer();
const toolFrames = new FrameTimer();

function towards(): Rgb | undefined {
    const chosen = resolveColour(activeTheme, color);
    if (chosen !== undefined) return chosen;
    for (const role of FALLBACK_ROLES) {
        const rgb = resolveColour(activeTheme, role);
        if (rgb !== undefined) return rgb;
    }
    return undefined;
}

function arm(): void {
    if (input === 'off') return;
    phase = { kind: 'waiting' };
}

// ---- input field ------------------------------------------------------

function paintField(editor: CustomEditor, lines: string[]): string[] {
    if (phase.kind === 'unarmed' || phase.kind === 'finished') return lines;
    if (editor.getText() !== '') {
        phase = { kind: 'finished' };
        return lines;
    }
    if (!editor.focused || running || editor.isShowingAutocomplete()) return lines;
    const rows = fieldRows(editor, lines);
    const toward = towards();
    if (rows === undefined || toward === undefined) return lines;

    const now = Date.now();
    if (phase.kind === 'waiting') phase = { kind: 'visible', since: now };
    const total = inputSeconds * 1000;
    const elapsed = now - phase.since;
    if (elapsed >= total) {
        phase = { kind: 'finished' };
        return lines;
    }
    const fadeStart = total - FADE_MS;
    const sky: Sky = {
        time: Math.min(elapsed, fadeStart) / 1000,
        visibility: elapsed > fadeStart ? (total - elapsed) / FADE_MS : 1,
        peak: strength,
        density,
        toward,
    };

    for (let i = rows.top + 1; i < rows.bottom; i++) {
        const line = lines[i]!;
        if (holdsImage([line])) continue;
        const row = readRow(line);
        const cursor = new Set<number>();
        let x = 0;
        for (const cell of row.cells) {
            if (cell.lead.includes(CURSOR_MARKER)) cursor.add(x);
            x += cell.width;
        }
        if (paintStars(row, i - rows.top, sky, (col) => cursor.has(col))) lines[i] = writeRow(row);
    }
    inputFrames.request(editorTui(editor), Math.min(FRAME_MS, total - elapsed));
    return lines;
}

// ---- tool rows --------------------------------------------------------

// `isPartial` and `ui` are private in ToolExecutionComponent's declaration.
interface ToolInternals {
    isPartial: boolean;
    ui: TUI;
}

const MARK = /\x1b_rho:star:(\d+)\x07/g;
const mark = (serial: number) => `\x1b_rho:star:${serial}\x07`;

let nextSerial = 0;
const serials = new WeakMap<ToolExecutionComponent, number>();
const started = new Map<number, number>();

interface Written {
    base: string;
    out: string;
}
let written = new Map<number, Written>();

/** stars into one line of a waiting row, `dy` rows down it. */
function starLine(line: string, serial: number, dy: number, toward: Rgb, now: number): string {
    if (holdsImage([line])) return line;
    const elapsed = now - (started.get(serial) ?? now);
    const row = readRow(line);
    const sky: Sky = {
        time: elapsed / 1000,
        visibility: Math.min(1, elapsed / FADE_MS),
        peak: strength,
        density,
        toward,
    };
    return paintStars(row, dy, sky) ? writeRow(row) : line;
}

function markRow(component: ToolExecutionComponent, lines: string[]): string[] {
    const internals = component as unknown as ToolInternals;
    const tui = internals.ui;
    let serial = serials.get(component);
    if (!internals.isPartial || !running) {
        if (serial !== undefined) started.delete(serial);
        return lines;
    }
    if (serial === undefined) {
        serial = nextSerial++;
        serials.set(component, serial);
    }
    if (!started.has(serial)) started.set(serial, Date.now());

    // `ui` is pi's reference to whichever renderer is current, and answers
    // instanceof for it. only the main screen redraws from a changed line
    // above the viewport; the alternate screen writes the rows in view and
    // nothing else, so there the row paints itself.
    if (tui instanceof TuiMainScreen) {
        return lines.map((line) => (line.includes('48;2;') ? mark(serial!) + line : line));
    }
    const toward = towards();
    if (toward === undefined) return lines;
    const now = Date.now();
    toolFrames.request(tui, FRAME_MS);
    return lines.map((line, dy) => starLine(line, serial!, dy, toward, now));
}

function paintFrame(tui: TuiMainScreen, lines: string[]): string[] {
    const top = (tui as unknown as { previousViewportTop?: number }).previousViewportTop ?? 0;
    const toward = towards();
    const now = Date.now();
    const rowOf = new Map<number, number>();
    const next = new Map<number, Written>();
    let animating = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        MARK.lastIndex = 0;
        const found = MARK.exec(line);
        if (found === null) continue;
        const serial = Number(found[1]);
        const base = line.replace(MARK, '');
        const dy = rowOf.get(serial) ?? 0;
        rowOf.set(serial, dy + 1);

        let out = base;
        if (i < top) {
            const before = written.get(i);
            if (before !== undefined && before.base === base) out = before.out;
        } else if (toward !== undefined) {
            out = starLine(base, serial, dy, toward, now);
            animating = true;
        }
        lines[i] = out;
        next.set(i, { base, out });
    }
    written = next;
    if (animating) toolFrames.request(tui, FRAME_MS);
    return lines;
}

// ---- wiring -----------------------------------------------------------

relay(ToolExecutionComponent.prototype, 'starfield.tool').set(tools ? markRow : undefined);
relay(TuiMainScreen.prototype, 'starfield.frame').set(tools ? paintFrame : undefined);

export default function (pi: ExtensionAPI) {
    pi.on('session_start', (_event, ctx) => {
        activeTheme = ctx.ui.theme;
        running = false;
        arm();
        relay(CustomEditor.prototype, 'starfield.editor').set(input === 'off' ? undefined : paintField);
    });
    pi.on('agent_start', () => {
        running = true;
    });
    pi.on('agent_end', () => {
        running = false;
        started.clear();
        if (input === 'turn') arm();
    });
}
