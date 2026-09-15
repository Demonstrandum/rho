// what a block of rendered lines looks like at its edges.
//
// two predicates over rendered output, shared by the extensions that tighten
// tool rows: halfblock-boxes.ts, which strips the blank rows a row wraps
// itself in, and tool-rows.ts, which boxes the tail pi's edit tool draws
// outside its own box.
import { isBlank } from './text';

/**
 * an inline image reserves its height as blank lines: after the escape sequence
 * under the kitty protocol, before it under iterm2. the terminal draws the
 * picture over that many rows whatever the transcript does, so dropping the
 * blanks makes the block shorter than the picture and the rows after it are
 * drawn on top. a block holding an image is therefore left alone.
 *
 * pi-tui has this predicate as isImageLine, but does not re-export it through
 * the package index, so the two prefixes are matched here. an iterm2 line also
 * has to be recognised before OSC stripping, which would leave it looking
 * blank.
 */
const KITTY_PREFIX = '\x1b_G';
const ITERM2_PREFIX = '\x1b]1337;File=';

export function holdsImage(lines: readonly string[]): boolean {
    return lines.some((line) => line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX));
}

/** the blank leading and trailing rows removed, unless an image needs them. */
export function trimBlankEdges(lines: readonly string[]): string[] {
    if (holdsImage(lines)) return [...lines];
    const out = [...lines];
    while (out.length > 0 && isBlank(out[0]!)) out.shift();
    while (out.length > 0 && isBlank(out[out.length - 1]!)) out.pop();
    return out;
}
