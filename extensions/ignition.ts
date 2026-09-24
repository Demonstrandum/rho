// a one-shot animation across the input field when the thinking level is
// raised to xhigh or max. after codex's effort ignition; the animation is in
// lib/chrome/ignition.ts, and `[ignition]` in rho.toml switches it and picks
// the styles.
//
// a change onto one of the two levels starts a play, with a style drawn from
// `styles` that differs from the last one. the clock starts on the first frame
// drawn, as codex's does, so a change made while the field is covered plays
// when it comes back. the patch goes through lib/tui/render-relay.ts and is
// installed at session_start, after input-field.ts has laid down the field's
// background, which is what the bands blend from.

import { CustomEditor, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { config } from './lib/core/config';
import { readRow, writeRow } from './lib/tui/cells';
import { holdsImage } from './lib/tui/box-edges';
import {
    FRAME_MS,
    durationMs,
    paintIgnition,
    pickStyle,
    type IgnitionStyle,
    type Tier,
} from './lib/chrome/ignition';
import { relay } from './lib/tui/render-relay';
import { FrameTimer } from './lib/tui/frame-timer';
import { editorTui, fieldRows } from './lib/tui/editor-field';

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const { enabled, styles } = config.ignition;

const TIERS: Partial<Record<ThinkingLevel, Tier>> = { xhigh: 'max', max: 'ultra' };

interface Play {
    style: IgnitionStyle;
    tier: Tier;
    since?: number;
}

let play: Play | undefined;
let last: IgnitionStyle | undefined;
let tui: TUI | undefined;
const frames = new FrameTimer();

function paint(editor: CustomEditor, lines: string[], width: number): string[] {
    tui = editorTui(editor);
    if (play === undefined) return lines;
    const rows = fieldRows(editor, lines);
    if (rows === undefined) return lines;

    const now = Date.now();
    play.since ??= now;
    const elapsedMs = now - play.since;
    if (elapsedMs >= durationMs(play.style, play.tier)) {
        play = undefined;
        return lines;
    }

    const indices: number[] = [];
    for (let i = rows.top; i <= rows.bottom; i++) {
        if (!holdsImage([lines[i]!])) indices.push(i);
    }
    const read = indices.map((i) => readRow(lines[i]!));
    const changed = paintIgnition(read, width, {
        style: play.style,
        tier: play.tier,
        elapsedMs,
        sparkRow: indices.indexOf(rows.top + 1),
    });
    for (const at of changed) lines[indices[at]!] = writeRow(read[at]!);
    frames.request(tui, FRAME_MS);
    return lines;
}

export default function (pi: ExtensionAPI) {
    if (!enabled) {
        pi.on('session_start', () => relay(CustomEditor.prototype, 'ignition.editor').set(undefined));
        return;
    }
    pi.on('session_start', () => {
        play = undefined;
        relay(CustomEditor.prototype, 'ignition.editor').set(paint);
    });
    pi.on('thinking_level_select', (event) => {
        const tier = TIERS[event.level];
        if (tier === undefined || event.level === event.previousLevel) return;
        const style = pickStyle(styles, last);
        last = style;
        play = { style, tier };
        tui?.requestRender();
    });
}
