// bun run extensions/lib/tool-row/exec.demo.ts [width] [theme]
//
// draws the collapsed and expanded previews the way a tool row would draw
// them: pi's theme colours, pi's syntax highlighter, the tool bubble
// background, and the half-block edges from halfblock-boxes.ts.
//
// pi's theme singleton is not on the package's exports map, so the theme
// module is imported by resolved path. that is a demo-only move; inside pi the
// theme arrives as a renderer argument.
import { collapse, expandCall, expandResult, parseExecCall, parseExecResult, type ExecCall } from './exec';
import type { RowTheme } from './theme';

const WIDTH = Number(process.argv[2] ?? 80);
const THEME_FILE = process.argv[3] ?? 'themes/plan9.json';

const themeModuleUrl = new URL('./modes/interactive/theme/theme.js', import.meta.resolve('@earendil-works/pi-coding-agent'));
const themeModule = await import(themeModuleUrl.href) as {
    loadThemeFromPath(path: string): PiTheme;
    setThemeInstance(theme: PiTheme): void;
    highlightCode(code: string, lang?: string): string[];
};

interface PiTheme {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
    bold(text: string): string;
}

const piTheme = themeModule.loadThemeFromPath(THEME_FILE);
themeModule.setThemeInstance(piTheme);

const theme: RowTheme = {
    fg: (color, text) => piTheme.fg(color, text),
    bold: (text) => piTheme.bold(text),
    highlight: (code, language) => themeModule.highlightCode(code, language),
};

// the bubble background as a foreground colour, for the half-block edges.
function bgAsFg(bg: 'toolSuccessBg' | 'toolErrorBg'): string {
    const sample = piTheme.bg(bg, ' ');
    const truecolor = sample.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
    if (truecolor) return `\x1b[38;2;${truecolor[1]};${truecolor[2]};${truecolor[3]}m`;
    const indexed = sample.match(/\x1b\[48;5;(\d+)m/);
    return indexed ? `\x1b[38;5;${indexed[1]}m` : '';
}

const CSI = /\x1b\[[0-9;]*m/g;

function visibleWidth(line: string): number {
    return [...line.replace(CSI, '')].length;
}

/**
 * pad to the bubble width and paint the background, as Box does. an overlong
 * line is clipped here; pi wraps it instead, so a clipped line in this demo is
 * a wrapped line in the TUI.
 */
function bubble(lines: string[], bg: 'toolSuccessBg' | 'toolErrorBg'): string[] {
    const fg = bgAsFg(bg);
    const edge = (char: string) => `${fg}${char.repeat(WIDTH)}\x1b[39m`;
    const body = lines.map((line) => {
        const over = visibleWidth(line) - (WIDTH - 2);
        const clipped = over > 0 ? clipVisible(line, WIDTH - 3) + '\u203a' : line;
        const pad = ' '.repeat(Math.max(0, WIDTH - 1 - visibleWidth(clipped)));
        return piTheme.bg(bg, ` ${clipped}${pad}`);
    });
    return [edge('\u2584'), ...body, edge('\u2580')];
}

/** cut to `budget` visible cells, keeping the escape sequences passed over. */
function clipVisible(line: string, budget: number): string {
    let out = '';
    let seen = 0;
    let i = 0;
    while (i < line.length && seen < budget) {
        const escape = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
        if (escape) {
            out += escape[0];
            i += escape[0].length;
            continue;
        }
        out += line[i];
        i++;
        seen++;
    }
    return out + '\x1b[39m';
}

interface Sample {
    name: string;
    tool: string;
    args: unknown;
    result: string;
    /** a reply context-mode threw, which pi marks as an error. */
    isError?: boolean;
}

const FENCE = '```';

const samples: Sample[] = [
    {
        name: 'shell, failed (zsh no matches)',
        isError: true,
        tool: 'ctx_execute',
        args: {
            language: 'shell',
            code: `cd /Users/samuel/Code/rho/node_modules/context-mode
rg -n '${FENCE}' dist/*.js 2>/dev/null | head -20
echo === files
ls; ls dist 2>/dev/null | head`,
        },
        result: `exit 2 · 98 B
zsh:3: no matches found: dist/*.js
/var/folders/p5/fhz_3y0x1gv865tck2wjhql00000gn/T/ctx-exec-15HZHi/code:4: == not found`,
    },
    {
        name: 'shell, ok',
        tool: 'ctx_execute',
        args: {
            language: 'shell',
            code: `cd /Users/samuel/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist
rg -n 'getAllTools|ToolInfo' core/agent-session.d.ts | head -20
echo === ToolInfo def
rg -rn 'interface ToolInfo|type ToolInfo' core/*.d.ts | head`,
        },
        result: `19:import { type ContextUsage } from "./extensions/index.ts";
306:    getAllTools(): ToolInfo[];
=== ToolInfo def
1146:export type ToolInfo = Pick<ToolDefinition, "name">;`,
    },
    {
        name: 'javascript, ok',
        tool: 'ctx_execute',
        args: {
            language: 'javascript',
            code: `const fs = require('fs');
// count lines per file
const files = fs.readdirSync('extensions').filter(f => f.endsWith('.ts'));
files.forEach(f => console.log(f, fs.readFileSync('extensions/' + f, 'utf8').split('\\n').length));`,
        },
        result: `auditor.ts 41
context.ts 388
cwd.ts 96`,
    },
    {
        name: 'shell, empty output',
        tool: 'ctx_execute',
        args: { language: 'shell', code: "rg -n 'x' server.bundle.mjs build/*.js | head" },
        result: 'exit 0 · 0 B\n',
    },
    {
        name: 'shell, grep found nothing (exit 1, not an error)',
        tool: 'ctx_execute',
        args: { language: 'shell', code: "rg -n 'nothing here' extensions" },
        result: 'exit 1 · 0 B\n',
    },
    {
        name: 'batch, 3 commands',
        tool: 'ctx_batch',
        args: {
            commands: [
                "rg -n 'renderCall|renderResult' /Users/samuel/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md | head -60",
                "rg -n 'renderCall|setToolRenderer' /Users/samuel/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md | head -40",
                "rg -n 'getAllTools' dist/core/*.d.ts | head -40",
            ],
            queries: ['how to register a tool call renderer'],
        },
        result: '## how to register a tool call renderer\n1598:  renderCall(args, theme, context) {\n1612:  renderResult(result, options, theme, context) {',
    },
    {
        name: 'execute with a file',
        tool: 'ctx_execute',
        args: {
            file: 'huge.log',
            language: 'javascript',
            code: `const errs = require('fs').readFileSync(process.env.CTX_FILE, 'utf8').split('\\n').filter(l => /ERROR|FATAL/.test(l));
console.log(errs.length + ' error lines');`,
        },
        result: '412 error lines\n',
    },
    {
        name: 'timeout',
        tool: 'ctx_execute',
        isError: true,
        args: { language: 'shell', code: 'sleep 700 && echo done' },
        result: 'Timed out after 600000 ms. Fix: pass background: true.',
    },
    {
        name: 'background',
        tool: 'ctx_execute',
        args: { language: 'shell', code: 'bun run dev', background: true },
        result: 'started in background, pid 48213',
    },
    {
        name: 'refused (outside the project)',
        tool: 'ctx_execute',
        isError: true,
        args: { language: 'shell', code: 'wc -l "$CTX_FILE"', file: '/tmp/out.log' },
        result: 'Path /tmp/out.log is outside the project. Fix: use a path inside /Users/samuel/Code/rho.',
    },
    {
        name: 'indexed (large stdout, with an intent)',
        tool: 'ctx_execute',
        args: { language: 'shell', code: 'rg -n TODO . | head -5000', intent: 'unfinished remote work' },
        result: 'exit 0 · 182044 B\n./docs/remote.md:185: TODO fetch only that range\n./extensions/remote.ts:41: TODO retry a dropped socket\nmore: ctx_search({queries:["unfinished remote work"],source:"ctx_execute:rg -n TODO . | head -5000"})',
    },
];

for (const sample of samples) {
    const call: ExecCall | null = parseExecCall(sample.tool, sample.args);
    if (!call) continue;
    const { outcome } = parseExecResult(sample.result, sample.isError === true);
    const bg = sample.isError === true ? 'toolErrorBg' : 'toolSuccessBg';
    const preview = collapse(call, outcome, WIDTH - 2, theme);

    // as pi would: two independently rendered slots, call then result, each
    // deciding its own collapsed/expanded form.
    console.log(`\n${piTheme.fg('dim', `${sample.name}  [${outcome.kind}]  collapsed`)}`);
    console.log(bubble([preview.call, ...(preview.output ? [preview.output] : [])], bg).join('\n'));
    console.log(piTheme.fg('dim', 'expanded'));
    console.log(bubble([...expandCall(call, theme), '', ...expandResult(call, outcome, theme)], bg).join('\n'));
}
