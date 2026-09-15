// the form of the command being typed, shown at the right-hand end of the
// input field:
//
//   /remote create pluto                 /remote create <name> <user@host>
//
// the hint is drawn into the field's own trailing padding, so it takes no row
// of its own and moves nothing. it is text under text: where the typed line
// reaches a column the hint wanted, the typed line keeps it.
//
// the fading is by proximity, not by position. a character of the hint is
// blended into the field background by how far it stands from the end of what
// has been typed: at the text it is the background exactly, and it comes up to
// `[hint] strength` over `[hint] fade` columns. so the hint retreats ahead of
// the cursor as the line grows, and the two are never legible in the same
// place at once.
//
// the character fades into the colour the row states at that column, read
// back out of the rendered row. the field's background is a gradient another
// patch lays down, so the theme cannot say what a column is painted with; a
// character faded towards a colour that is not under it passes through
// something brighter than either end on the way, which is what a hint
// approaching the typed line looked like before this.
//
// so the patch has to run after the background pass, which means it goes on
// CustomEditor.prototype.render (input-field.ts replaces that method and calls
// the base itself, so a patch on the base runs before it) and is installed at
// session_start rather than at load, when every extension has had its turn and
// whatever is on the prototype then is the whole of the rendering.

import { CustomEditor, type ExtensionAPI, type Theme } from '@earendil-works/pi-coding-agent';
import { config } from './lib/config';
import { hintFor, type KnownCommand } from './lib/command-usage';
import { overlayHint, placeHint } from './lib/command-hint';
import { resolveColour } from './lib/colour-spec';
import { plain, visibleWidth } from './lib/text';
import { type Rgb } from './lib/utils';

const { enabled, color, gap, fade, strength } = config.hint;

let activeTheme: Theme | undefined;
let commands: readonly KnownCommand[] = [];

// what the hint is drawn in when the configured colour yields nothing. a
// theme can leave a role empty, which means the terminal's own default and so
// has no rgb to blend towards: plan9-dark writes `text: ""`, and a hint that
// fell back to it was drawn in no colour at all, which is to say not drawn.
const FALLBACK_ROLES = ['muted', 'dim', 'border', 'accent', 'text'] as const;

// every lookup goes through resolveColour, which answers undefined for an
// empty role, for a name the theme does not hold, and for a terminal in
// 256-colour mode. the theme throws on an unknown name, and a render patch
// that throws takes the frame with it.
function hintRgb(): Rgb | undefined {
    const chosen = resolveColour(activeTheme, color);
    if (chosen !== undefined) return chosen;
    for (const role of FALLBACK_ROLES) {
        const rgb = resolveColour(activeTheme, role);
        if (rgb !== undefined) return rgb;
    }
    return undefined;
}

let installed = false;

/**
 * wrap whatever renders the editor now. called at session_start, so a patch
 * another extension installed at load is inside this one and its colours are
 * there to be read.
 */
function install(): void {
    if (installed) return;
    installed = true;

    const render = CustomEditor.prototype.render;

    CustomEditor.prototype.render = function (this: CustomEditor, width: number): string[] {
        const lines = render.call(this, width);
        if (!this.focused) return lines;

        // the hint belongs beside the text, so it is shown only while the
        // whole text is on one row: the content row is then lines[1], between
        // the two borders, and every column past the cursor is padding.
        if (lines.length < 3 || this.getLines().length !== 1) return lines;

        const text = this.getText();
        const hint = hintFor(text, commands);
        if (hint === undefined) return lines;

        // the padding is measured off the row rather than read from the
        // editor: input-field.ts bumps paddingX for the duration of its own
        // render and puts it back, so by the time this runs the editor reports
        // one column less than the row was drawn with, and the hint sat that
        // column too far right. the text starts with a slash, so the columns
        // before it are the left padding, and the right padding matches it.
        const padding = plain(lines[1]).indexOf(text[0]);
        if (padding < 0) return lines;

        // one column for the block cursor, which sits past the last character.
        const textEnd = padding + visibleWidth(text) + 1;
        const placed = placeHint(hint, { width, padding, textEnd, gap });
        if (placed === undefined) return lines;

        const fg = hintRgb();
        if (fg === undefined) return lines;

        // where the row states no background of its own, the bubble colour the
        // field is derived from stands in. that is the case while
        // `[input] background` is off, and no column while it is on.
        const written = overlayHint(lines[1], placed, textEnd, {
            fg,
            fallback: () => resolveColour(activeTheme, 'userMessageBg'),
            fade,
            strength,
        });
        // a column with nothing behind it has nothing to fade into, so the
        // hint is dropped rather than drawn at one strength throughout.
        if (written === undefined) return lines;

        lines[1] = written;
        return lines;
    };
}

export default function (pi: ExtensionAPI) {
    if (!enabled) return;
    pi.on('session_start', (_event, ctx) => {
        activeTheme = ctx.ui.theme;
        // read once the session is up, when prompts and skills have been
        // registered alongside the extension commands.
        commands = pi.getCommands();
        install();
    });
}
