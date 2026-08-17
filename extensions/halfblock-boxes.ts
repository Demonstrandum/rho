// replace the default Box shell on built-in tools with half-block edges.
// saves one line of vertical space per tool call (the blank padding line
// above and below the content becomes a half-height colored strip).
//
// uses renderShell: "self" on each built-in tool override. execution and
// slot renderers (renderCall, renderResult) inherit from the built-in.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, type Component } from '@earendil-works/pi-tui';

const LOWER_HALF = '\u2584'; // ▄
const UPPER_HALF = '\u2580'; // ▀

function visibleWidth(s: string): number {
    return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\][^\x07]*\x07/g, '').length;
}

class HalfBlockBox implements Component {
    private child: Component | null = null;
    private bgFn: (s: string) => string;
    private fgColor: string;
    private paddingX: number;

    constructor(bgFn: (s: string) => string, fgColor: string, paddingX = 1) {
        this.bgFn = bgFn;
        this.fgColor = fgColor;
        this.paddingX = paddingX;
    }

    setChild(child: Component) { this.child = child; }

    render(width: number): string[] {
        const out: string[] = [];
        const reset = '\x1b[0m';
        const pad = ' '.repeat(this.paddingX);

        out.push(`${this.fgColor}${LOWER_HALF.repeat(width)}${reset}`);

        if (this.child) {
            const inner = Math.max(1, width - this.paddingX * 2);
            for (const cl of this.child.render(inner)) {
                const fill = ' '.repeat(Math.max(0, inner - visibleWidth(cl)));
                out.push(this.bgFn(`${pad}${cl}${fill}${pad}`));
            }
        }

        out.push(`${this.fgColor}${UPPER_HALF.repeat(width)}${reset}`);
        return out;
    }

    invalidate() { this.child?.invalidate(); }
}

// extract the fg ANSI escape for the tool bg color (to use on half-block chars)
function extractFgFromBg(theme: any): string {
    try {
        const sample = (theme.bg as Function)('toolBg', ' ');
        const m = sample.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
        if (m) return `\x1b[38;2;${m[1]};${m[2]};${m[3]}m`;
    } catch { /* */ }
    return '\x1b[38;5;236m';
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        const theme = ctx.ui.theme as any;
        if (!theme) return;

        const toolBg = (s: string) => (theme.bg as Function)('toolBg', s) as string;
        const fgColor = extractFgFromBg(theme);

        for (const toolInfo of (pi as any).getAllTools()) {
            const info = toolInfo as any;
            // only override the built-in tools (they have sourceInfo.source === 'builtin')
            if (info.sourceInfo?.source !== 'builtin') continue;

            (pi as any).registerTool({
                name: info.name,
                label: info.label ?? info.name,
                description: info.description,
                parameters: info.parameters,
                renderShell: 'self',
                executionMode: info.executionMode,
                execute: info.execute,
                // renderCall omitted: inherits built-in (tool name label).
                // renderResult: wrap in HalfBlockBox instead of default Box.
                renderResult(result: any, options: any, thm: any, context: any) {
                    let box = context.lastComponent as HalfBlockBox | undefined;
                    if (!box || !(box instanceof HalfBlockBox)) {
                        box = new HalfBlockBox(toolBg, fgColor);
                    }
                    const content = typeof result === 'string'
                        ? result
                        : result?.content?.[0]?.text ?? JSON.stringify(result);
                    box.setChild(new Text(content, 0, 0));
                    return box;
                },
            });
        }
    });
}
