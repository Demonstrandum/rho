// where the usage hint goes in a row of the input field, and what colour each
// of its characters is.
//
// pure, so the arithmetic that decides whether a hint fits (and how much of it
// the typed line has already pushed off the left) can be checked without a
// terminal. the extension holds the patch; this holds the sums.

import { spans } from '../core/text';
import { type Rgb, ansiFg, blend } from '../core/utils';

export interface HintPlacement {
    /** the first column the hint occupies. */
    readonly start: number;
    /** the hint as much of it as fits, left-clipped. */
    readonly text: string;
}

export interface HintRoom {
    readonly width: number;
    /** the field's horizontal padding, as the editor applied it. */
    readonly padding: number;
    /** the column just past the typed line, cursor included. */
    readonly textEnd: number;
    /** columns kept clear between the typed line and the hint. */
    readonly gap: number;
}

/**
 * fit `hint` into the padding at the right-hand end of the row. the hint is
 * right-aligned and clipped from the left, since its tail is the part the
 * reader has not typed yet. undefined when no column is left for it.
 *
 * the clip is by column, not by word. clipping to a word boundary drops
 * several characters at once, and since the fade is by distance from the
 * typed line, the surviving head then starts further right and is drawn
 * brighter: the hint dims as the line advances and then jumps back up at
 * every boundary. by column, the leading character sits at a fixed distance
 * from the line and so holds one brightness, and a character half cut is a
 * character the fade has already taken to the background.
 */
export function placeHint(hint: string, room: HintRoom): HintPlacement | undefined {
    const right = room.width - room.padding;
    const available = right - (room.textEnd + room.gap);
    if (available < 1) return undefined;

    const text = hint.length <= available ? hint : hint.slice(hint.length - available);
    return { start: right - text.length, text };
}

export interface HintColours {
    /** the colour the hint reaches at its clearest. */
    readonly fg: Rgb;
    /**
     * what to fade into where the row states no background of its own. asked
     * only when such a column turns up, which is none of them while the field
     * paints its own background.
     */
    readonly fallback: () => Rgb | undefined;
    /** columns over which the hint comes up out of the background. */
    readonly fade: number;
    /** how far out of the background it comes, at most. */
    readonly strength: number;
}

/** what an escape sequence does to the background: set it, or clear it. */
function backgroundAfter(escape: string, held: Rgb | undefined): Rgb | undefined {
    const set = /48;2;(\d+);(\d+);(\d+)/.exec(escape);
    if (set !== null) return [Number(set[1]), Number(set[2]), Number(set[3])];
    // \x1b[0m and \x1b[49m both put the background back to the terminal's own,
    // which is a colour this process does not know.
    if (/^\x1b\[(?:0?|49)m$/.test(escape)) return undefined;
    return held;
}

/**
 * write the hint into `row`, over the columns it was placed at.
 *
 * the colour each character fades into is read out of the row itself, as the
 * background in force at that column, rather than computed a second time from
 * the theme. the field's background is a gradient laid down by another render
 * patch, so the only account of what a column is actually painted with is the
 * row that patch produced: fading towards a colour derived from the theme
 * instead puts the character on a path to somewhere it is not, and the middle
 * of that path is a character brighter than either end.
 *
 * every escape in the row is kept where it was, which is what carries those
 * backgrounds through: only the visible characters under the hint are
 * replaced. undefined when a covered column states no background and none was
 * given to fall back to.
 */
export function overlayHint(
    row: string,
    placed: HintPlacement,
    textEnd: number,
    colours: HintColours,
): string | undefined {
    const end = placed.start + placed.text.length;
    const out: string[] = [];
    let column = 0;
    let background: Rgb | undefined;
    let written = 0;

    for (const span of spans(row)) {
        if (!span.visible) {
            background = backgroundAfter(span.text, background);
            out.push(span.text);
            continue;
        }
        for (const character of span.text) {
            if (column < placed.start || column >= end) {
                out.push(character);
            } else {
                const under = background ?? colours.fallback();
                if (under === undefined) return undefined;
                const reach = Math.min(1, Math.max(0, (column - textEnd) / colours.fade));
                out.push(ansiFg(blend(under, colours.fg, reach * colours.strength)) + placed.text[written]);
                written++;
                // default foreground, not a full reset: the background in
                // force at this column is the row's to state, not this.
                if (written === placed.text.length) out.push('\x1b[39m');
            }
            column++;
        }
    }

    if (written < placed.text.length) return undefined;
    return out.join('');
}
