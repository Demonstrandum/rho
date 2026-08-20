// replace pi's built-in startup block (logo + key-hint wall + the "[Prompts]"
// style bracketed resource listing) with a compact, bold-inline header topped
// by an animated pi wordmark.
//
// pi renders its own block in core and it is not reformattable in place, so the
// approach is: (1) persist quietStartup=true to suppress the built-in block,
// (2) draw our own via ctx.ui.setHeader().
//
// the header runs a ~2s one-shot intro on session start: a quick fade-in (or,
// 1/3 of the time, a block-by-block build-up), then a diagonal down-right
// shimmer, then the "pi vX" label types out with a blinking cursor. it drives
// its own repaints with a timer + tui.requestRender() and clears the timer once
// settled, so nothing animates after the header scrolls out of view. render() is
// a pure function of elapsed time, so resizes/repaints stay consistent.
//
// resource data comes from the public API: pi.getCommands() distinguishes
// prompts / skills / extension commands by `source`, and ctx.ui.getAllThemes()
// lists themes. there is no API to enumerate the loaded extension *files*, so
// there is no "Extensions" section; the extension-provided slash commands show
// under "commands" instead.

import type { ExtensionAPI, SlashCommandInfo, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { ensureGlobalSetting } from './lib/settings-store';
import { zip, choose, themeRgb, blend, ansiFg, RESET, type Rgb } from './lib/utils';
import { config } from './lib/config';
import {
    createTetrisState, tickTetris,
    PIECE_COLORS_DARK, PIECE_COLORS_LIGHT,
} from './lib/tetris-logo';
import {
    LOGO_W, LOGO_H, CENTER_ROW, SCALE_X, SCALE_Y,
    DEFAULT_INTRO_MS, TYPE_PER_CHAR_MS, CURSOR_TAIL_MS, FRAME_MS,
    FADE_RAMP, SHIMMER_DIRS,
    type IntroMode, type ShimmerDir, type LinearShimmerDir, type Timeline,
    timeline, orderFor, shimmerDirFor, renderLogoLines, plainLogoRow, logoCenterRow,
} from './lib/pi-logo';

// a short discoverability hint. keep it minimal; the footer carries model/token
// state, so this only points at the two universal entry points.
const HINT = '/ commands · ! shell';

const LABEL_HEADS   = [ 'pi', 'π'];
const LABEL_SUBS    = ['rho', 'ϱ'];
const LABEL_WEIGHTS = [ 0.67, 0.33];
const LABEL_TAIL = ` v${VERSION}`;

// intro duration per mode. the shared defaults cover every mode but tetris,
// whose drop sequence needs longer.
const INTRO_MS: Record<IntroMode, number> = {
    ...DEFAULT_INTRO_MS,
    tetris: 1600,
};

const MODE_NAMES: readonly IntroMode[] = ['fade', 'build', 'scatter', 'pi', 'rho', 'tetris'];

// 'pirho' was the old name for the two-trace mode, now 'rho'.
function parseMode(name: string): IntroMode | null {
    const resolved = name === 'pirho' ? 'rho' : name;
    return MODE_NAMES.includes(resolved as IntroMode) ? (resolved as IntroMode) : null;
}

function getConfiguredModes(): { modes: IntroMode[]; weights: number[] } {
    const modes: IntroMode[] = [];
    const weights: number[] = [];
    for (let i = 0; i < config.startup.modes.length; i++) {
        const mode = parseMode(config.startup.modes[i]);
        if (mode) {
            modes.push(mode);
            weights.push(config.startup.weights[i] ?? 0);
        }
    }
    if (modes.length === 0) return { modes: ['fade'], weights: [1] };
    return { modes, weights };
}

// the wordmark is a list of styled segments; the type-on reveal walks the
// concatenation while each segment keeps its own colour/weight. head (pi) is
// bold accent, sub (rho) is the same accent unbolded, the version tail is dim.
interface LabelSegment {
    readonly text: string;
    readonly style: (theme: Theme, s: string) => string;
}

function labelLength(segments: readonly LabelSegment[]): number {
    return segments.reduce((n, seg) => n + seg.text.length, 0);
}

function renderLabel(theme: Theme, segments: readonly LabelSegment[], t: number, tl: Timeline, finished: boolean): string {
    const total = labelLength(segments);
    const shown = finished ? total : Math.max(0, Math.min(total, Math.floor((t - tl.typeStart) / TYPE_PER_CHAR_MS)));
    let out = '';
    let remaining = shown;
    for (const seg of segments) {
        const take = Math.max(0, Math.min(seg.text.length, remaining));
        if (take > 0) {
            out += seg.style(theme, seg.text.slice(0, take));
        }
        remaining -= seg.text.length;
    }
    if (finished) {
        return out;
    }
    // cursor: solid while typing (no blink), then dissolve through the density ramp.
    const typeEnd = tl.typeStart + total * TYPE_PER_CHAR_MS;
    let cursor: string;
    if (t < typeEnd) {
        cursor = '█';
    } else {
        const progress = (t - typeEnd) / CURSOR_TAIL_MS;
        cursor = FADE_RAMP[Math.max(0, FADE_RAMP.length - 1 - Math.floor(progress * FADE_RAMP.length))]!;
    }
    if (cursor !== ' ') {
        out += theme.fg('accent', cursor);
    }
    return out;
}

interface Section {
    readonly label: string;
    readonly items: readonly string[];
    // for the themes section: the name of the currently active theme, so it can
    // render bold while the rest stay dim.
    readonly current?: string;
}

function sortedNames(commands: readonly SlashCommandInfo[], source: SlashCommandInfo['source'], prefix: string): string[] {
    return commands
        .filter((command) => command.source === source)
        .map((command) => `${prefix}${command.name}`)
        .sort((a, b) => a.localeCompare(b));
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode !== 'tui') {
            return;
        }

        try {
            ensureGlobalSetting(['quietStartup'], true);
        } catch {
            // best effort: a settings write failure must never break startup.
        }

        // pick the intro style once per session from config.
        const { modes, weights } = getConfiguredModes();
        const mode = choose(modes, weights);
        
        // block fills reveal cells in order; scatter uses a random permutation.
        const order = orderFor(mode);
        // pick the wordmark once per session (weighted pi/rho vs π/ϱ).
        const [head, sub] = choose(zip(LABEL_HEADS, LABEL_SUBS), LABEL_WEIGHTS);
        const label: LabelSegment[] = [
            { text: head, style: (theme, s) => theme.bold(theme.fg('accent', s)) },
            { text: sub, style: (theme, s) => theme.fg('accent', s) },
            { text: LABEL_TAIL, style: (theme, s) => theme.fg('dim', s) },
        ];
        // pick the shimmer direction once per session (uniform over the four axes).
        // path-based intros use matching shimmer directions; others pick a random axis.
        // trace modes use their own path; the rest sweep an axis from config.
        const configuredDirs = config.startup.shimmerDirs.filter(
            (d): d is LinearShimmerDir => (SHIMMER_DIRS as readonly string[]).includes(d),
        );
        const linearDir = choose(configuredDirs.length > 0 ? configuredDirs : SHIMMER_DIRS);
        const dir: ShimmerDir = shimmerDirFor(mode, linearDir);
        // config.startup.durationMs sets the total; the timeline scales to fit.
        const tl = timeline(INTRO_MS[mode], mode, labelLength(label), config.startup.durationMs);
        // the drop sequence owns the whole intro window, so the clear finishes
        // exactly as the shimmer takes over the settled glyph.
        const tetrisState = mode === 'tetris' ? createTetrisState(tl.introEnd) : null;

        ctx.ui.setHeader((tui, theme) => {
            const start = Date.now();
            let done = !config.startup.animate;
            const timer = config.startup.animate
                ? setInterval(() => {
                    if (Date.now() - start >= tl.settleAt) {
                        done = true;
                        clearInterval(timer);
                    }
                    tui.requestRender();
                }, FRAME_MS)
                : undefined;

            return {
                dispose() {
                    if (timer) clearInterval(timer);
                },
                invalidate() {},
                render(width: number): string[] {
                    const t = Date.now() - start;
                    const finished = done || t >= tl.settleAt;
                    
                    // tick tetris state
                    if (tetrisState && t < tl.introEnd) {
                        tickTetris(tetrisState, t);
                    }

                    const accentRgb = themeRgb(theme, 'accent');
                    // tetris piece colours follow the theme's light/dark cast.
                    const isLight = theme.name?.toLowerCase().includes('light') ?? false;
                    const tetrisColors = isLight ? PIECE_COLORS_LIGHT : PIECE_COLORS_DARK;

                    // truecolor: the shared renderer draws every cell. 256-color
                    // terminals have no rgb to blend, so they get flat accent.
                    const logoLines = accentRgb
                        ? renderLogoLines({
                            t, mode, dir, order, tl, finished,
                            accent: accentRgb, tetrisColors, tetrisState,
                        })
                        : Array.from({ length: LOGO_H }, (_, row) =>
                            theme.fg('accent', plainLogoRow(row, t, mode, order, tl, finished)));

                    if (finished || t >= tl.typeStart) {
                        const labelRow = accentRgb ? logoCenterRow(mode) : CENTER_ROW;
                        logoLines[labelRow] += `   ${renderLabel(theme, label, t, tl, finished)}`;
                    }

                    const commands = pi.getCommands();
                    const sections: Section[] = [
                        { label: 'prompts', items: sortedNames(commands, 'prompt', '/') },
                        { label: 'skills', items: sortedNames(commands, 'skill', '') },
                        { label: 'commands', items: sortedNames(commands, 'extension', '/') },
                        {
                            label: 'themes',
                            items: ctx.ui
                                .getAllThemes()
                                .filter((entry) => entry.path !== undefined)
                                .map((entry) => entry.name)
                                .sort((a, b) => a.localeCompare(b)),
                            current: theme.name,
                        },
                    ].filter((section) => section.items.length > 0);

                    const labelWidth = sections.reduce((max, section) => Math.max(max, section.label.length), 0);
                    const lines = [...logoLines, '', theme.fg('dim', HINT)];
                    for (const section of sections) {
                        const label = theme.bold(theme.fg('accent', section.label.padEnd(labelWidth)));
                        if (section.current && section.items.includes(section.current)) {
                            // active theme: same `dim` color as the rest, just bold.
                            const parts = section.items.map((name) =>
                                name === section.current
                                    ? theme.bold(theme.fg('dim', name))
                                    : theme.fg('dim', name),
                            );
                            lines.push(`${label}  ${parts.join(theme.fg('dim', ', '))}`);
                        } else {
                            lines.push(`${label}  ${theme.fg('dim', section.items.join(', '))}`);
                        }
                    }

                    return ['', ...lines.map((line) => truncateToWidth(line, width, theme.fg('dim', '...'))), ''];
                },
            };
        });
    });
}
