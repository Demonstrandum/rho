// replace the default Box shell on built-in tools with half-block edges.
// modelled directly on pi-tui's Box component, but replaces the paddingY
// blank lines with half-height block characters.
import {
    createBashTool,
    createEditTool,
    createFindTool,
    createGrepTool,
    createLsTool,
    createReadTool,
    createWriteTool,
    type ExtensionAPI,
    type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Text, visibleWidth, type Component } from '@earendil-works/pi-tui';
// @ts-ignore - not re-exported from package index but exists in dist
import { applyBackgroundToLine } from '@earendil-works/pi-tui/dist/utils.js';

const LOWER_HALF = '\u2584';
const UPPER_HALF = '\u2580';

// modelled on Box from pi-tui/dist/components/box.js, but with half-block
// top/bottom edges instead of full blank padding lines.
class HalfBlockBox implements Component {
    child: Component | null = null;
    bgFn: ((s: string) => string) | undefined;
    fgColor: string;
    paddingX: number;

    constructor(fgColor: string, bgFn?: (s: string) => string, paddingX = 1) {
        this.fgColor = fgColor;
        this.bgFn = bgFn;
        this.paddingX = paddingX;
    }

    render(width: number): string[] {
        const out: string[] = [];

        // top edge: lower half block, fg = box bg color
        out.push(`${this.fgColor}${LOWER_HALF.repeat(width)}\x1b[39m`);

        // content (same as Box.render)
        if (this.child) {
            const contentWidth = Math.max(1, width - this.paddingX * 2);
            const leftPad = ' '.repeat(this.paddingX);
            for (const line of this.child.render(contentWidth)) {
                const padded = leftPad + line;
                const visLen = visibleWidth(padded);
                const fill = ' '.repeat(Math.max(0, width - visLen));
                const full = padded + fill;
                out.push(this.bgFn ? applyBackgroundToLine(full, width, this.bgFn) : full);
            }
        }

        // bottom edge: upper half block, fg = box bg color
        out.push(`${this.fgColor}${UPPER_HALF.repeat(width)}\x1b[39m`);

        return out;
    }

    invalidate() { this.child?.invalidate(); }
}

function bgToFg(theme: any, key: string): string {
    try {
        const sample = theme.bg(key, ' ');
        const m = sample.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
        if (m) return `\x1b[38;2;${m[1]};${m[2]};${m[3]}m`;
    } catch { /* */ }
    return '\x1b[38;5;236m';
}

interface BuiltTool {
    name: string;
    label: string;
    description: string;
    parameters: any;
    prepareArguments?: any;
    executionMode?: ToolDefinition['executionMode'];
    execute(...args: unknown[]): Promise<any>;
}

function toDefinition(tool: BuiltTool, renderResult: ToolDefinition['renderResult']): ToolDefinition {
    return {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        prepareArguments: tool.prepareArguments,
        executionMode: tool.executionMode,
        renderShell: 'self',
        execute: (id, params, signal, onUpdate) => tool.execute(id, params, signal, onUpdate),
        renderResult,
    };
}

export default function (pi: ExtensionAPI) {
    let registered = false;

    pi.on('session_start', async (_event, ctx) => {
        if (registered) return;
        registered = true;

        try {
            const theme = ctx.ui.theme as any;
            if (!theme) return;

            const fgSuccess = bgToFg(theme, 'toolSuccessBg');
            const fgError = bgToFg(theme, 'toolErrorBg');
            const fgPending = bgToFg(theme, 'toolPendingBg');

            const makeRenderer = (): ToolDefinition['renderResult'] =>
                (result: any, _options: any, _thm: any, context: any) => {
                    const bgKey = context.isError ? 'toolErrorBg'
                        : context.isPartial ? 'toolPendingBg'
                        : 'toolSuccessBg';
                    const fg = context.isError ? fgError
                        : context.isPartial ? fgPending
                        : fgSuccess;
                    const bgFn = (s: string) => theme.bg(bgKey, s);

                    let box = context.lastComponent as HalfBlockBox | undefined;
                    if (box instanceof HalfBlockBox) {
                        box.bgFn = bgFn;
                        box.fgColor = fg;
                    } else {
                        box = new HalfBlockBox(fg, bgFn);
                    }

                    const text = typeof result === 'string'
                        ? result
                        : result?.content?.[0]?.text ?? JSON.stringify(result);
                    box.child = new Text(text, 0, 0);
                    return box;
                };

            const cwd = ctx.cwd;
            const tools: BuiltTool[] = [
                createReadTool(cwd),
                createWriteTool(cwd),
                createEditTool(cwd),
                createBashTool(cwd),
                createGrepTool(cwd),
                createFindTool(cwd),
                createLsTool(cwd),
            ];

            for (const tool of tools) {
                pi.registerTool(toDefinition(tool, makeRenderer()));
            }
        } catch {
            // silent: default Box rendering continues.
        }
    });
}
