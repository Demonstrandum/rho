// pick the colours code is drawn in, apart from the theme that draws everything
// else.
//
//   /syntax           the picker: a code sample above the list, restyled as the
//                     cursor moves
//   /syntax <name>    complete the name, and every name passed over is applied
//                     while the menu is open
//   /syntax none      back to the theme's own syntax colours
//
// a theme fixes its own nine syntax colours, so a theme that is right for the
// chrome can still be wrong for code. this separates the two: the palettes are
// in extensions/assets/syntax.json and lib/syntax-palette.ts lays one over
// whichever theme is in force.
//
// a palette is judged on code, not on a name, so both routes apply it for real
// and show a sample highlighted through pi's own highlighter. leaving either
// route without choosing puts back the palette that was in force on entry.
//
// `[syntax] persist` keeps the choice in rho's own state, since pi's settings
// have nowhere to record one: a theme name is all they hold.

import {
    DynamicBorder,
    highlightCode,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    type Theme,
} from '@earendil-works/pi-coding-agent';
import { Container, SelectList, Text, type SelectItem } from '@earendil-works/pi-tui';
import { config } from './lib/config';
import { PersistedState } from './lib/state-store';
import { previewHold, type PreviewHold } from './lib/preview-hold';
import { watchAutocompleteFocus } from './lib/autocomplete-focus';
import { SideBySide } from './lib/side-by-side';
import { chosenPalette, choosePalette, palettes, paletteNamed, restyle, themeUnder } from './lib/syntax-palette';

/** the name that stands for the theme's own colours. */
const NONE = 'none';

const HINT = 'up/down preview, enter keep, esc cancel';

/** what the picker highlights: one line of each role the palettes set. */
const SAMPLE = `// the rows a session has drawn, oldest first
export interface Turn {
    readonly index: number;
    readonly label: string;
}

export function summarise(turns: readonly Turn[], limit = 20): string {
    const shown = turns.filter((turn) => turn.index >= limit);
    if (shown.length === 0) return "nothing yet";
    return \`\${shown.length} turns, from \${shown[0].label}\`;
}`;

/** columns the list is given in the picker, and the rule between the two. */
const LIST_WIDTH = 24;
const GUTTER = ' \u2502 ';

/** under this the two columns are stacked, since neither would be readable. */
const MIN_SIDE_BY_SIDE = 64;

interface PaletteChoice {
    readonly name: string;
    readonly origin: string;
}

interface ChoiceState {
    readonly palette: string;
}

function parseChoice(raw: unknown): ChoiceState | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const value = (raw as Record<string, unknown>).palette;
    return typeof value === 'string' ? { palette: value } : null;
}

/**
 * the list beside the sample. the sample is highlighted on every frame rather
 * than once, because the theme it is highlighted through changes under the
 * cursor: that is the point of it.
 */
function sampleBeside(list: SelectList, theme: () => Theme): SideBySide {
    return new SideBySide(list, () => highlightCode(SAMPLE, 'typescript'), {
        leftWidth: LIST_WIDTH,
        rule: () => theme().fg('dim', GUTTER),
        ruleWidth: GUTTER.length,
        minWidth: MIN_SIDE_BY_SIDE,
    });
}

export default function (pi: ExtensionAPI) {
    let store: PersistedState<ChoiceState> | null = null;
    // the hold behind the completion menu, so the command that follows a chosen
    // name commits the same palette the menu was previewing.
    let menuPreview: PreviewHold<string> | null = null;
    // the completion list is asked for outside any command, where no context is
    // passed, so the session's own is held from session_start.
    let live: ExtensionContext | null = null;

    const choices = (): PaletteChoice[] => [
        { name: NONE, origin: "the theme's own syntax colours" },
        ...palettes().map((entry) => ({ name: entry.name, origin: entry.origin })),
    ];

    /** the palette in force, by name. */
    const current = (): string => chosenPalette()?.name ?? NONE;

    /**
     * show a palette without recording it.
     *
     * pi applies a Theme object and saves nothing, which is what a preview
     * wants: the dozen palettes passed over on the way to a choice leave no
     * trace, and the choice is written by `keep`.
     */
    const show = (ctx: ExtensionContext, name: string): boolean => {
        const theme = themeUnder(ctx.ui.theme);
        if (name === NONE) {
            choosePalette(null);
            return ctx.ui.setTheme(theme).success;
        }
        const palette = paletteNamed(name);
        if (palette === undefined) {
            ctx.ui.notify(`no syntax palette named ${name}`, 'error');
            return false;
        }
        choosePalette(palette);
        return ctx.ui.setTheme(restyle(theme, palette)).success;
    };

    /** what a preview replaced, for as long as the preview is on screen. */
    const hold = (ctx: ExtensionContext): PreviewHold<string> =>
        previewHold<string>({ read: () => current(), write: (name) => show(ctx, name) });

    /** the choice: applied, and kept unless [syntax] persist says otherwise. */
    const keep = (ctx: ExtensionContext, name: string, preview: PreviewHold<string>): void => {
        if (!show(ctx, name)) return;
        preview.commit();
        if (config.syntax.persist) store?.write({ palette: name });
    };

    pi.on('session_start', (_event, ctx: ExtensionContext) => {
        live = ctx;

        store = PersistedState.open(
            { name: 'syntax', scope: 'global', parse: parseChoice },
            { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
        );
        const saved = config.syntax.persist ? store.read() : null;
        if (saved !== null && saved.palette !== NONE) show(ctx, saved.palette);

        if (ctx.mode !== 'tui' || !config.syntax.previewOnFocus) return;

        const claims = (text: string): boolean => /^\s*\/syntax\s/.test(text);
        const preview = hold(ctx);
        menuPreview = preview;

        watchAutocompleteFocus({
            claims,
            focus(item: SelectItem) {
                preview.preview(item.value);
            },
            close(chosen: SelectItem | null) {
                // a chosen name stays on screen until the command runs, and the
                // command is what keeps it. anything else goes back.
                if (chosen === null) preview.revert();
            },
        });
    });

    pi.registerCommand('syntax', {
        description: 'change the colours code is drawn in, previewing each palette',
        getArgumentCompletions(prefix: string) {
            const wanted = prefix.trim().toLowerCase();
            const here = current();
            const items = choices()
                .filter((entry) => entry.name.toLowerCase().includes(wanted))
                .map((entry) => ({
                    value: entry.name,
                    label: entry.name,
                    description: entry.name === here ? '(current)' : entry.origin,
                }));
            return items.length === 0 ? null : items;
        },
        async handler(args: string, ctx: ExtensionCommandContext) {
            const name = args.trim();
            if (name === '') {
                await picker(ctx);
                return;
            }
            if (choices().every((entry) => entry.name !== name)) {
                ctx.ui.notify(`no syntax palette named ${name}`, 'error');
                return;
            }
            keep(ctx, name, menuPreview ?? hold(ctx));
        },
    });

    /**
     * the picker: the names on the left, the code they colour on the right.
     *
     * it is the bordered box every other picker in a session is, drawn in the
     * dock where pi draws them, rather than an overlay over the transcript: a
     * palette is chosen from a session that is still on screen behind it.
     *
     * the sample is highlighted by pi's own highlighter through the theme in
     * force, so what the list previews is the colouring a code block in the
     * transcript gets, not a swatch drawn to look like one.
     */
    const picker = async (ctx: ExtensionContext): Promise<void> => {
        const preview = hold(ctx);
        // no descriptions: the left column is a column, and the origin of a
        // palette is not what the reader is comparing.
        const items: SelectItem[] = choices().map((entry) => ({ value: entry.name, label: entry.name }));

        const chosen = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
            const list = new SelectList(items, Math.min(items.length, 12), {
                selectedPrefix: (t: string) => theme.fg('accent', t),
                selectedText: (t: string) => theme.fg('accent', t),
                description: (t: string) => theme.fg('muted', t),
                scrollInfo: (t: string) => theme.fg('dim', t),
                noMatch: (t: string) => theme.fg('warning', t),
            });
            list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === current())));
            list.onSelect = (item: SelectItem) => done(item.value);
            list.onCancel = () => done(null);
            list.onSelectionChange = (item: SelectItem) => {
                preview.preview(item.value);
                tui.requestRender();
            };

            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
            container.addChild(new Text(theme.fg('accent', theme.bold('syntax')), 1, 0));
            container.addChild(sampleBeside(list, () => ctx.ui.theme));
            container.addChild(new Text(theme.fg('dim', HINT), 1, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

            return {
                render: (width: number) => container.render(width),
                invalidate: () => container.invalidate(),
                handleInput: (data: string) => list.handleInput(data),
            };
        });

        if (chosen === null) {
            preview.revert();
            return;
        }
        keep(ctx, chosen, preview);
    };
}
