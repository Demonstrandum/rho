// shortens the tool rows context-mode draws for ctx_execute, ctx_execute_file,
// and ctx_batch_execute: a highlighted one-line command, a status tag and
// output digest, and full detail on expand. gated by [render] exec-preview in
// rho.toml.
//
// context-mode registers these tools itself (mcp-bridge.js) with its own
// renderCall/renderResult (tool name only; first output line, truncated).
// re-registering the same tool name from a second extension is the wrong
// lever: `getAllRegisteredTools()` keeps first-registration-wins by extension
// load order, so a competing registration would either lose silently or, if
// it won, would have to reimplement context-mode's MCP stdio bridge to have
// anything to execute. instead this patches ToolExecutionComponent's render
// dispatch directly, the same way halfblock-boxes.ts patches its `render`:
// it is keyed on the running tool name, so it wins regardless of which
// extension registered the tool.
//
// `getCallRenderer`/`getResultRenderer` and the `toolName` they dispatch on
// are `private` in ToolExecutionComponent's declaration (TS-private, plain
// JS at runtime, same situation halfblock-boxes.ts's BoxInternals reaches
// past). ToolExecutionInternals below names exactly the members reached,
// mirroring that cast rather than opening the whole receiver up.
import {
    ToolExecutionComponent,
    highlightCode,
    type AgentToolResult,
    type ExtensionAPI,
    type Theme,
    type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { config } from './lib/config';
import {
    collapseCall,
    collapseResult,
    expandCall,
    expandResult,
    isExecTool,
    parseExecCall,
    parseExecResult,
    type PreviewColor,
    type PreviewTheme,
} from './lib/exec-preview';

const { execPreview } = config.render;

if (execPreview) {
    // pi's real Theme has fg/bold as methods and highlightCode as a standalone
    // export, not a Theme method; this adapts that shape to PreviewTheme.
    function adaptTheme(theme: Theme): PreviewTheme {
        return {
            fg: (color: PreviewColor, text: string) => theme.fg(color, text),
            bold: (text: string) => theme.bold(text),
            highlight: (code: string, language: string) => highlightCode(code, language),
        };
    }

    // the deferred-width component: pi calls Component.render(width) on
    // every layout pass, including terminal resize, without rebuilding the
    // component, so the ladder-fitting in collapseCall/collapseResult must
    // run inside render(width), not at construction time.
    class ExecPreviewLines implements Component {
        constructor(private readonly build: (width: number) => string[]) {}
        render(width: number): string[] {
            return this.build(width);
        }
        invalidate(): void {}
    }

    type RenderCallFn = (args: unknown, theme: Theme, context: RenderCtx) => Component;
    type RenderResultFn = (
        result: AgentToolResult<unknown>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: RenderCtx,
    ) => Component;

    // ToolRenderContext isn't exported from the package root; this names only
    // the fields actually read here.
    interface RenderCtx {
        args: unknown;
        expanded: boolean;
    }

    interface ToolExecutionInternals {
        toolName: string;
        getCallRenderer(): RenderCallFn | undefined;
        getResultRenderer(): RenderResultFn | undefined;
    }

    const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionInternals;

    const origGetCallRenderer = proto.getCallRenderer;
    proto.getCallRenderer = function (this: ToolExecutionInternals): RenderCallFn | undefined {
        const toolName = this.toolName;
        if (!isExecTool(toolName)) return origGetCallRenderer.call(this);

        return (args, theme, context) => {
            const call = parseExecCall(toolName, args);
            if (!call) {
                return new ExecPreviewLines(() => [theme.fg('toolTitle', theme.bold(toolName))]);
            }
            const previewTheme = adaptTheme(theme);
            if (context.expanded) {
                const lines = expandCall(call, previewTheme);
                return new ExecPreviewLines(() => lines);
            }
            return new ExecPreviewLines((width) => [collapseCall(call, width, previewTheme)]);
        };
    };

    const origGetResultRenderer = proto.getResultRenderer;
    proto.getResultRenderer = function (this: ToolExecutionInternals): RenderResultFn | undefined {
        const toolName = this.toolName;
        if (!isExecTool(toolName)) return origGetResultRenderer.call(this);

        return (result, options, theme, context) => {
            const call = parseExecCall(toolName, context.args);
            if (!call) return new ExecPreviewLines(() => []);

            if (options.isPartial) {
                return new ExecPreviewLines(() => [theme.fg('warning', 'running\u2026')]);
            }

            const text = (result.content ?? [])
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof (c as { text?: unknown }).text === 'string')
                .map((c) => c.text)
                .join('\n');
            const { outcome } = parseExecResult(text);
            const previewTheme = adaptTheme(theme);

            if (options.expanded) {
                const lines = expandResult(call, outcome, previewTheme);
                return new ExecPreviewLines(() => lines);
            }
            return new ExecPreviewLines((width) => {
                const line = collapseResult(call, outcome, width, previewTheme);
                return line ? [line] : [];
            });
        };
    };
}

export default function (_pi: ExtensionAPI) {}
