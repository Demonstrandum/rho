// two ways to change the theme, both of which show it before you commit to it.
//
//   /theme            the picker: the intro card, a sample session, and a list
//   /theme <name>     complete the name, and every name you pass over is
//                     applied while the menu is open
//
// a theme is judged on a session, not on a name, so both routes apply the theme
// for real rather than drawing a swatch: pi's setTheme repaints everything, and
// the reader sees the transcript, the footer and the input field in the theme
// under the cursor. leaving either route without choosing puts back the theme
// that was active on entry.
//
// the completion menu reports what is chosen and not what is merely under the
// cursor, so lib/autocomplete-focus.ts patches that in; the sample session is
// lib/theme-sample.ts and the card is lib/intro-card.ts, the same one startup
// draws, replayed on every preview because that is the animation a theme is
// first seen through.
//
// `[theme] persist` writes the choice to pi's settings, so a picked theme
// survives a restart the way one picked in /settings does.

import {
    CustomEditor,
    getSelectListTheme,
    ThemeSelectorComponent,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    type Theme,
} from '@earendil-works/pi-coding-agent';
import type { KeybindingsManager } from '@earendil-works/pi-coding-agent';
import type { SelectItem, TUI } from '@earendil-works/pi-tui';
import { visibleWidth } from './lib/text';
import { config } from './lib/config';
import { createIntro, type IntroCard } from './lib/intro-card';
import { headerLines } from './lib/startup-header';
import { lastFooter } from './lib/footer-mirror';
import { previewHold, type PreviewHold } from './lib/preview-hold';
import { watchAutocompleteFocus } from './lib/autocomplete-focus';
import { FRAME_MS } from './lib/pi-logo';
import { sampleSession } from './lib/theme-sample';

const HINT = 'up/down preview, enter keep, esc cancel';

/** what the sample input field holds, so the field is shown with text in it. */
const TYPED = 'and now make the footer read the width it is given';

/** below this the frame is drawn anyway and the terminal clips it. */
const MIN_HEIGHT = 12;

/**
 * pad a line out to the full width. an overlay draws over what is under it
 * only where it puts characters, so a short line would leave the transcript
 * showing through the rest of the row.
 */
function cover(line: string, width: number): string {
    const room = width - visibleWidth(line);
    return room > 0 ? line + ' '.repeat(room) : line;
}

/**
 * the session's input field, holding a line nobody sent. pi builds this from an
 * EditorTheme, which is a border colour and a select-list theme, both of which
 * the current theme answers, so the field in the preview is the real component
 * with the real styling, including this package's own patch of it.
 */
function sampleEditor(tui: TUI, keybindings: KeybindingsManager, theme: Theme): CustomEditor {
    const editor = new CustomEditor(
        tui,
        { borderColor: theme.getThinkingBorderColor('medium'), selectList: getSelectListTheme() },
        keybindings,
        { paddingX: 1 },
    );
    editor.setText(TYPED);
    return editor;
}

interface ThemeChoice {
    readonly name: string;
    readonly current: boolean;
}

export default function (pi: ExtensionAPI) {
    // the hold behind the completion menu, so the command that follows a
    // chosen name commits the same one the menu was previewing.
    let menuPreview: PreviewHold<string> | null = null;
    // the completion list is asked for outside any command, where no context is
    // passed, so the session's own is held from session_start.
    let live: ExtensionContext | null = null;

    const themes = (ctx: ExtensionContext): ThemeChoice[] => {
        const current = ctx.ui.theme.name;
        return ctx.ui.getAllThemes().map((entry) => ({ name: entry.name, current: entry.name === current }));
    };

    /**
     * show a theme without saving it.
     *
     * setTheme writes the name into pi's settings, which is right for a choice
     * and wrong for the dozen themes passed over on the way to it: a preview
     * would leave whichever one the cursor last touched as the saved theme, and
     * would overwrite an `auto` setting with a fixed name. handed a Theme
     * object instead, pi applies it and saves nothing, so that is the form a
     * preview and a restore take.
     */
    const show = (ctx: ExtensionContext, name: string): boolean => {
        const theme = ctx.ui.getTheme(name);
        if (theme === undefined) {
            ctx.ui.notify(`no theme named ${name}`, 'error');
            return false;
        }
        return ctx.ui.setTheme(theme).success;
    };

    /** what a preview replaced, for as long as the preview is on screen. */
    const hold = (ctx: ExtensionContext): PreviewHold<string> =>
        previewHold<string>({ read: () => ctx.ui.theme.name, write: (name) => show(ctx, name) });

    /** the choice: applied, and saved unless [theme] persist says otherwise. */
    const keep = (ctx: ExtensionContext, name: string, preview: PreviewHold<string>): void => {
        const applied = config.theme.persist ? ctx.ui.setTheme(name).success : show(ctx, name);
        if (!applied) {
            ctx.ui.notify(`theme ${name}: not applied`, 'error');
            return;
        }
        preview.commit();
    };

    pi.on('session_start', (_event, ctx: ExtensionContext) => {
        live = ctx;
        if (ctx.mode !== 'tui' || !config.theme.previewOnFocus) return;

        // `/theme ` with an argument being completed, and nothing else.
        const claims = (text: string): boolean => /^\s*\/theme(?:-picker)?\s/.test(text);

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

    pi.registerCommand('theme', {
        description: 'change the theme, previewing each one as you pass over it',
        getArgumentCompletions(prefix: string) {
            if (live === null) return null;
            const wanted = prefix.trim().toLowerCase();
            const items = themes(live)
                .filter((entry) => entry.name.toLowerCase().includes(wanted))
                .map((entry) => ({
                    value: entry.name,
                    label: entry.name,
                    ...(entry.current ? { description: '(current)' } : {}),
                }));
            return items.length === 0 ? null : items;
        },
        async handler(args: string, ctx: ExtensionCommandContext) {
            const name = args.trim();
            if (name === '') {
                await picker(ctx);
                return;
            }
            const match = themes(ctx).find((entry) => entry.name === name);
            if (match === undefined) {
                ctx.ui.notify(`no theme named ${name}`, 'error');
                return;
            }
            keep(ctx, match.name, menuPreview ?? hold(ctx));
        },
    });

    pi.registerCommand('theme-picker', {
        description: 'pick a theme against a sample session',
        async handler(_args: string, ctx: ExtensionCommandContext) {
            await picker(ctx);
        },
    });

    /**
     * the picker: one screen, fixed height, drawn by the components that draw a
     * real session.
     *
     * the frame is composed bottom-up and always fills the terminal exactly.
     * the card is a constant four rows, the list and the input field sit at the
     * bottom, and the sample transcript takes what is left, scrolled to its end
     * the way a session is. so nothing moves as the card animates or as a
     * taller theme is previewed: a row that has no content is a blank row, not
     * a shift.
     *
     * it covers every row. an overlay paints only where it puts characters, so
     * every line is padded out to the width and the frame is padded out to the
     * height; a row left short would show the session's own transcript through
     * the gap.
     */
    const picker = async (ctx: ExtensionContext): Promise<void> => {
        if (ctx.ui.getAllThemes().length === 0) {
            ctx.ui.notify('no themes are loaded', 'warning');
            return;
        }
        const preview = hold(ctx);

        const chosen = await ctx.ui.custom<string | null>(
            (tui, _theme, keybindings, done) => {
                let intro: IntroCard = createIntro();
                let started = Date.now();
                let sample = sampleSession({ tui, cwd: ctx.cwd });
                let editor = sampleEditor(tui, keybindings, ctx.ui.theme);
                const timer = setInterval(() => tui.requestRender(), FRAME_MS);

                // pi's own selector: the list /settings shows, with its preview
                // hook, so neither the rows nor their keys are reinvented.
                const selector = new ThemeSelectorComponent(
                    ctx.ui.theme.name ?? '',
                    (name: string) => done(name),
                    () => done(null),
                    (name: string) => {
                        preview.preview(name);
                        if (ctx.ui.theme.name !== name) return;
                        // a theme change is a new session as far as the preview
                        // is concerned: pi's components take their colours as
                        // they build their lines, so they are built again, and
                        // the card plays from the top the way a session opens.
                        intro = createIntro();
                        started = Date.now();
                        sample = sampleSession({ tui, cwd: ctx.cwd });
                        editor = sampleEditor(tui, keybindings, ctx.ui.theme);
                    },
                );

                return {
                    render(width: number): string[] {
                        const theme = ctx.ui.theme;
                        const height = Math.max(MIN_HEIGHT, tui.terminal.rows);
                        const opening = [
                            '',
                            ...headerLines({
                                intro,
                                theme,
                                elapsed: Date.now() - started,
                                commands: pi.getCommands(),
                                themes: ctx.ui
                                    .getAllThemes()
                                    .filter((entry) => entry.path !== undefined)
                                    .map((entry) => entry.name),
                            }),
                            '',
                            ...sample.opening.render(width),
                        ];
                        const bottom = [
                            ...selector.render(width),
                            theme.fg('dim', HINT),
                            '',
                            ...editor.render(width),
                            ...lastFooter(),
                        ];
                        const room = Math.max(0, height - bottom.length - opening.length);
                        // the transcript is read from its end, as a real one
                        // is, so what does not fit is clipped from the top of
                        // it and the card and the question stay whole.
                        const body = sample.body.render(width);
                        const shown = body.slice(Math.max(0, body.length - room));
                        // the spare rows are head room above the card, the way
                        // a short session sits at the bottom of the screen.
                        // anywhere else they open a gap inside it.
                        const blanks = Array.from({ length: room - shown.length }, () => '');
                        return [...blanks, ...opening, ...shown, ...bottom]
                            .slice(0, height)
                            .map((line) => cover(line, width));
                    },
                    invalidate(): void {
                        sample.opening.invalidate();
                        sample.body.invalidate();
                        selector.invalidate();
                        editor.invalidate();
                    },
                    handleInput(data: string): void {
                        selector.getSelectList().handleInput(data);
                    },
                    dispose(): void {
                        clearInterval(timer);
                    },
                };
            },
            {
                overlay: true,
                overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-center', margin: 0 },
            },
        );

        if (chosen === null) {
            preview.revert();
            return;
        }
        keep(ctx, chosen, preview);
    };
}
