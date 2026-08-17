// replace the default Box shell on built-in tools with half-block edges.
// saves one line of vertical space per tool call (the blank padding line
// above and below becomes a half-height colored strip).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, type Component } from '@earendil-works/pi-tui';

const LOWER_HALF = '\u2584';
const UPPER_HALF = '\u2580';

function stripAnsi(s: string): number {
    return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\][^\x07]*\x07/g, '').length;
}

class HalfBlockBox implements Component {
    private child: Component | null = null;
    private bgFn: (s: string) => string;
    private fgColor: string;
    private px: number;

    constructor(bgFn: (s: string) => string, fgColor: string, px = 1) {
        this.bgFn = bgFn;
        this.fgColor = fgColor;
        this.px = px;
    }

    setChild(c: Component) { this.child = c; }

    render(width: number): string[] {
        const reset = '\x1b[0m';
        const pad = ' '.repeat(this.px);
        const out: string[] = [];

        out.push(`${this.fgColor}${LOWER_HALF.repeat(width)}${reset}`);

        if (this.child) {
            const inner = Math.max(1, width - this.px * 2);
            for (const line of this.child.render(inner)) {
                const fill = ' '.repeat(Math.max(0, inner - stripAnsi(line)));
                out.push(this.bgFn(`${pad}${line}${fill}${pad}`));
            }
        }

        out.push(`${this.fgColor}${UPPER_HALF.repeat(width)}${reset}`);
        return out;
    }

    invalidate() { this.child?.invalidate(); }
}

function extractToolFgColor(theme: any): string {
    try {
        const sample = theme.bg('toolBg', ' ');
        const m = sample.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
        if (m) return `\x1b[38;2;${m[1]};${m[2]};${m[3]}m`;
    } catch { /* theme key might differ */ }
    return '\x1b[38;5;236m';
}

export default function (pi: ExtensionAPI) {
    let registered = false;

    pi.on('session_start', async (_event, ctx) => {
        if (registered) return;
        registered = true;

        try {
            const theme = ctx.ui.theme as any;
            const toolBg = theme
                ? (s: string) => theme.bg('toolBg', s)
                : (s: string) => `\x1b[48;5;236m${s}\x1b[0m`;
            const fgColor = theme ? extractToolFgColor(theme) : '\x1b[38;5;236m';

            for (const info of pi.getAllTools()) {
                if ((info as any).sourceInfo?.source !== 'builtin') continue;

                (pi.registerTool as any)({
                    name: info.name,
                    description: info.description,
                    parameters: info.parameters,
                    renderShell: 'self',
                    renderResult(result: any, _options: any, _thm: any, context: any) {
                        let box = context.lastComponent as HalfBlockBox | undefined;
                        if (!box || !(box instanceof HalfBlockBox)) {
                            box = new HalfBlockBox(toolBg, fgColor);
                        }
                        const text = typeof result === 'string'
                            ? result
                            : result?.content?.[0]?.text ?? JSON.stringify(result);
                        box.setChild(new Text(text, 0, 0));
                        return box;
                    },
                });
            }
        } catch (e) {
            // if anything fails, skip. default Box rendering still works.
        }
    });
}
