// /context: a context-window readout for pi, in the spirit of Claude Code's
// /context command. it draws a chess-tile grid sized to the model's context
// window, coloured by category, with a legend of estimated per-category usage.
//
// how the numbers are found. pi exposes the authoritative total via
// ctx.getContextUsage() (it reuses the last assistant usage, then estimates any
// trailing messages), so the header + grid fill reflect the real token count.
// the per-category split is estimated locally at pi's own chars/4 ratio:
//   - system prompt: est(getSystemPrompt()) minus the memory + skill listing it embeds
//   - tools:         est over the active tools' name + description + json schema
//   - memory files:  est over each loaded context file's content (AGENTS.md etc)
//   - skills:        est over the skill listing (name + description, not bodies)
//   - messages:      the remainder (real total minus the fixed overhead above)
// categories are estimates, so they are labelled as such; the total and free
// space come from the real count. this mirrors what Claude Code shows.
//
// rendering. the command computes a plain-data readout and appends it as a
// CustomEntry (registerEntryRenderer), which draws in the transcript but does
// NOT enter the LLM context, so asking for /context never pollutes the very
// thing it measures. the renderer is a pure function of width, so it reflows on
// resize.

import type {
    EntryRenderOptions,
    ExtensionAPI,
    Theme,
    ThemeColor,
    ToolInfo,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

const ENTRY_TYPE = 'rho-context-readout';

const FILLED = '⛁';
const EMPTY = '⛶';

// grid geometry. 20x10 = 200 cells span the whole window, so one cell is
// window/200 tokens (5k at a 1M window). shrinks gracefully on narrow terminals.
const COLS = 20;
const ROWS = 10;

type CatKey = 'systemPrompt' | 'tools' | 'memory' | 'skills' | 'messages';

const CATS: Record<CatKey, { label: string; color: ThemeColor }> = {
    systemPrompt: { label: 'System prompt', color: 'accent' },
    tools: { label: 'Tools', color: 'warning' },
    memory: { label: 'Memory files', color: 'success' },
    skills: { label: 'Skills', color: 'mdLink' },
    messages: { label: 'Messages', color: 'text' },
};
// fixed legend order, top to bottom.
const CAT_ORDER: readonly CatKey[] = ['systemPrompt', 'tools', 'memory', 'skills', 'messages'];

interface CatUsage {
    readonly key: CatKey;
    readonly tokens: number;
}

interface Readout {
    readonly modelName: string;
    readonly modelRef: string;
    readonly contextWindow: number;
    readonly totalTokens: number | null;
    readonly cats: readonly CatUsage[];
    readonly free: number | null;
    readonly toolCount: number;
    readonly skillCount: number;
    readonly memoryCount: number;
}

// pi estimates tokens at ~4 chars/token; match that for the category split.
const est = (s: string): number => Math.ceil(s.length / 4);

function fmtTok(n: number): string {
    if (n < 1000) return String(n);
    const k = n / 1000;
    if (k < 1000) return `${round1(k)}k`;
    return `${round1(k / 1000)}m`;
}

function fmtWindow(n: number): string {
    if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
    if (n >= 1000) return `${trimZero(n / 1000)}K`;
    return String(n);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const trimZero = (x: number): string => String(round1(x)).replace(/\.0$/, '');
const pct1 = (part: number, whole: number): string => (whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0');

// largest-remainder apportionment: split `total` cells across weights so the
// parts are integers that sum to exactly `total`.
function apportion(weights: readonly number[], total: number): number[] {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0 || total <= 0) return weights.map(() => 0);
    const raw = weights.map((w) => (w / sum) * total);
    const floors = raw.map(Math.floor);
    let used = floors.reduce((a, b) => a + b, 0);
    const remainders = raw
        .map((r, i) => ({ i, frac: r - Math.floor(r) }))
        .sort((a, b) => b.frac - a.frac);
    for (let k = 0; used < total && k < remainders.length; k++, used++) {
        floors[remainders[k].i]++;
    }
    return floors;
}

function buildReadout(
    modelName: string,
    modelRef: string,
    contextWindow: number,
    totalTokens: number | null,
    systemPrompt: string,
    contextFiles: ReadonlyArray<{ content: string }>,
    skills: ReadonlyArray<{ name: string; description: string }>,
    tools: readonly ToolInfo[],
    activeToolNames: readonly string[],
): Readout {
    const memoryTokens = contextFiles.reduce((s, f) => s + est(f.content), 0);
    const skillsTokens = skills.reduce((s, sk) => s + est(`${sk.name} ${sk.description}`), 0);
    const systemPromptTokens = Math.max(0, est(systemPrompt) - memoryTokens - skillsTokens);

    const active = new Set(activeToolNames);
    const toolsTokens = tools
        .filter((t) => active.has(t.name))
        .reduce(
            (s, t) => s + est(`${t.name}\n${t.description ?? ''}\n${JSON.stringify(t.parameters ?? {})}`),
            0,
        );

    const fixed = systemPromptTokens + toolsTokens + memoryTokens + skillsTokens;
    const messagesTokens = totalTokens === null ? null : Math.max(0, totalTokens - fixed);

    const byKey: Record<CatKey, number> = {
        systemPrompt: systemPromptTokens,
        tools: toolsTokens,
        memory: memoryTokens,
        skills: skillsTokens,
        messages: messagesTokens ?? 0,
    };

    const cats: CatUsage[] = [];
    for (const key of CAT_ORDER) {
        // omit empty memory / skills, matching Claude Code's behaviour.
        if ((key === 'memory' && contextFiles.length === 0) || (key === 'skills' && skills.length === 0)) {
            continue;
        }
        if (key === 'messages' && messagesTokens === null) continue;
        cats.push({ key, tokens: byKey[key] });
    }

    return {
        modelName,
        modelRef,
        contextWindow,
        totalTokens,
        cats,
        free: totalTokens === null ? null : Math.max(0, contextWindow - totalTokens),
        toolCount: active.size,
        skillCount: skills.length,
        memoryCount: contextFiles.length,
    };
}

function renderReadout(data: Readout, theme: Theme, width: number): string[] {
    const dim = (s: string): string => theme.fg('dim', s);
    const swatch = (key: CatKey): string => theme.fg(CATS[key].color, FILLED);
    const win = data.contextWindow;

    // legend text, right of (or below) the grid.
    const legend: string[] = [];
    legend.push(theme.bold(theme.fg('accent', data.modelName)) + dim(` (${fmtWindow(win)} context)`));
    legend.push(dim(data.modelRef));
    if (data.totalTokens === null) {
        legend.push(dim('usage pending (post-compaction)'));
    } else {
        legend.push(
            `${theme.fg('text', fmtTok(data.totalTokens))}${dim(`/${fmtTok(win)} tokens (${Math.round((data.totalTokens / win) * 100)}%)`)}`,
        );
    }
    legend.push('');
    legend.push(dim('Estimated usage by category'));
    for (const cat of data.cats) {
        legend.push(`${swatch(cat.key)} ${CATS[cat.key].label}: ${fmtTok(cat.tokens)} ${dim(`tokens (${pct1(cat.tokens, win)}%)`)}`);
    }
    if (data.free !== null) {
        legend.push(`${dim(EMPTY)} ${dim(`Free space: ${fmtTok(data.free)} tokens (${pct1(data.free, win)}%)`)}`);
    }

    // grid: fill used cells (row-major) coloured by category, remainder empty.
    const usedFraction = data.totalTokens ?? data.cats.reduce((s, c) => s + c.tokens, 0);
    const cols = Math.max(8, Math.min(COLS, Math.floor((width - 2) / 2)));
    const cells = cols * ROWS;
    const usedCells = Math.max(0, Math.min(cells, Math.round((usedFraction / win) * cells)));
    const perCat = apportion(data.cats.map((c) => c.tokens), usedCells);
    const cellColor: ThemeColor[] = [];
    data.cats.forEach((c, i) => {
        for (let k = 0; k < perCat[i]; k++) cellColor.push(CATS[c.key].color);
    });

    const gridRows: string[] = [];
    for (let r = 0; r < ROWS; r++) {
        let row = '';
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            row += idx < usedCells ? theme.fg(cellColor[idx], FILLED) : dim(EMPTY);
            row += ' ';
        }
        gridRows.push(row);
    }

    const gridWidth = visibleWidth(gridRows[0]);
    const notes: string[] = [dim(`tools ${data.toolCount} active · skills ${data.skillCount} loaded · memory ${data.memoryCount} files`)];

    // side by side when the terminal is wide enough, else stacked.
    const sideBySide = width >= gridWidth + 26;
    const out: string[] = [dim('Context Usage'), ''];
    if (sideBySide) {
        const n = Math.max(gridRows.length, legend.length);
        for (let i = 0; i < n; i++) {
            const left = truncateToWidth(gridRows[i] ?? '', gridWidth, '', true);
            const right = legend[i] ?? '';
            out.push(right ? `${left}  ${right}` : left);
        }
        out.push('');
        out.push(...notes);
    } else {
        out.push(...gridRows, '', ...legend, '', ...notes);
    }
    return out.map((line) => truncateToWidth(line, width, dim('…')));
}

export default function (pi: ExtensionAPI) {
    pi.registerEntryRenderer<Readout>(ENTRY_TYPE, (entry, _options: EntryRenderOptions, theme): Component | undefined => {
        const data = entry.data;
        if (!data) return undefined;
        return {
            invalidate() {},
            render(width: number): string[] {
                return renderReadout(data, theme, width);
            },
        };
    });

    pi.registerCommand('context', {
        description: 'Show context-window usage as a grid, by category',
        handler: async (_args, ctx) => {
            const model = ctx.model;
            if (!model) {
                ctx.ui.notify('no model selected', 'warning');
                return;
            }
            const usage = ctx.getContextUsage();
            const contextWindow = usage?.contextWindow ?? model.contextWindow;
            const totalTokens = usage?.tokens ?? null;

            const opts = ctx.getSystemPromptOptions?.();
            const contextFiles = opts?.contextFiles ?? [];
            const skills = opts?.skills ?? [];

            const readout = buildReadout(
                model.name,
                `${model.provider}/${model.id}`,
                contextWindow,
                totalTokens,
                ctx.getSystemPrompt(),
                contextFiles,
                skills,
                pi.getAllTools(),
                pi.getActiveTools(),
            );

            pi.appendEntry<Readout>(ENTRY_TYPE, readout);
        },
    });
}
