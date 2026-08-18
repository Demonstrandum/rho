// bun run extensions/lib/exec-preview.demo.ts [width] [theme]
//
// draws the collapsed and expanded previews the way a tool row would draw
// them: pi's theme colours, pi's syntax highlighter, the tool bubble
// background, and the half-block edges from halfblock-boxes.ts.
//
// pi's theme singleton is not on the package's exports map, so the theme
// module is imported by resolved path. that is a demo-only move; inside pi the
// theme arrives as a renderer argument.
import { collapse, expandCall, expandResult, parseExecCall, parseExecResult, type ExecCall, type PreviewTheme } from './exec-preview';

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

const theme: PreviewTheme = {
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
}

const FENCE = '```';

const samples: Sample[] = [
    {
        name: 'shell, soft fail (zsh no matches)',
        tool: 'ctx_execute',
        args: {
            language: 'shell',
            code: `cd /Users/samuel/Code/rho/node_modules/context-mode
rg -n '${FENCE}' dist/*.js 2>/dev/null | head -20
echo === files
ls; ls dist 2>/dev/null | head`,
        },
        result: `${FENCE}shell
cd /Users/samuel/Code/rho/node_modules/context-mode
rg -n '${FENCE}' dist/*.js 2>/dev/null | head -20
echo === files
ls; ls dist 2>/dev/null | head
${FENCE}

Exit code: 1

stdout:


stderr:
/var/folders/p5/fhz_3y0x1gv865tck2wjhql00000gn/T/.ctx-mode-15HZHi/script.sh:3: no matches found: dist/*.js
/var/folders/p5/fhz_3y0x1gv865tck2wjhql00000gn/T/.ctx-mode-15HZHi/script.sh:4: == not found`,
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
        result: `${FENCE}shell
cd /Users/samuel/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist
rg -n 'getAllTools|ToolInfo' core/agent-session.d.ts | head -20
${FENCE}

19:import { type ContextUsage } from "./extensions/index.ts";
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
        result: `${FENCE}javascript
const fs = require('fs');
${FENCE}

auditor.ts 41
context.ts 388
cwd.ts 96`,
    },
    {
        name: 'shell, empty output',
        tool: 'ctx_execute',
        args: { language: 'shell', code: "rg -n 'x' server.bundle.mjs build/*.js | head" },
        result: `${FENCE}shell
rg -n 'x' server.bundle.mjs build/*.js | head
${FENCE}

(no output)`,
    },
    {
        name: 'batch, 3 commands',
        tool: 'ctx_batch_execute',
        args: {
            commands: [
                { label: 'extensions doc renderers', command: "rg -n 'renderCall|renderResult' /Users/samuel/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md | head -60" },
                { label: 'tui doc renderers', command: "rg -n 'renderCall|setToolRenderer' /Users/samuel/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md | head -40" },
                { label: 'pi api tool registry', command: "rg -n 'getAllTools' dist/core/*.d.ts | head -40" },
            ],
            queries: ['how to register a tool call renderer'],
            concurrency: 3,
        },
        result: 'Executed 3 commands (59 lines, 5.1KB). Indexed 4 sections. Searched 4 queries.',
    },
    {
        name: 'execute_file',
        tool: 'ctx_execute_file',
        args: {
            path: 'huge.log',
            language: 'javascript',
            code: `const errs = FILE_CONTENT.split('\\n').filter(l => /ERROR|FATAL/.test(l));
console.log(errs.length + ' error lines');`,
        },
        result: `path=huge.log
${FENCE}javascript
const errs = FILE_CONTENT.split('\\n');
${FENCE}

412 error lines`,
    },
    {
        name: 'timeout, no output',
        tool: 'ctx_execute',
        args: { language: 'shell', code: 'sleep 60 && echo done' },
        result: `${FENCE}shell
sleep 60 && echo done
${FENCE}

Execution timed out after 30000ms

stderr:
`,
    },
    {
        name: 'indexed (large stdout)',
        tool: 'ctx_execute',
        args: { language: 'shell', code: 'rg -n TODO . | head -5000' },
        result: `${FENCE}shell
rg -n TODO . | head -5000
${FENCE}

Indexed 37 sections (12 with code) from: execute:shell
Use ctx_search(queries: ["..."]) to query this content.`,
    },
];

for (const sample of samples) {
    const call: ExecCall | null = parseExecCall(sample.tool, sample.args);
    if (!call) continue;
    const { outcome } = parseExecResult(sample.result);
    const bg = outcome.kind === 'exit' || outcome.kind === 'timeout' ? 'toolErrorBg' : 'toolSuccessBg';
    const preview = collapse(call, outcome, WIDTH - 2, theme);

    // as pi would: two independently rendered slots, call then result, each
    // deciding its own collapsed/expanded form.
    console.log(`\n${piTheme.fg('dim', `${sample.name}  [${outcome.kind}]  collapsed`)}`);
    console.log(bubble([preview.call, ...(preview.output ? [preview.output] : [])], bg).join('\n'));
    console.log(piTheme.fg('dim', 'expanded'));
    console.log(bubble([...expandCall(call, theme), '', ...expandResult(call, outcome, theme)], bg).join('\n'));
}
