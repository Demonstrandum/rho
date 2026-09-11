// every tool row: one naming scheme, and a row that says what the call did.
//
// pi draws a row in two slots, the call and the result. a tool that ships a
// renderCall writes its own name into the call slot (`read`, `bash`), and a
// tool that ships none gets ToolExecutionComponent's fallback, which is the
// bare name the model calls and nothing else: `slack_reply`, `ctx_search`,
// `web_search`, with a JSON dump of the arguments under it. so a row's name
// came from as many places as there are tool authors, and half the rows said
// nothing about what they did.
//
// three behaviours, each switched by a key in [tools] of rho.toml:
//
//   titles        a tool's display name (lib/tool-row/title.ts) replaces the
//                 name the model calls, wherever that name is drawn.
//   detail        a tool with no renderCall of its own gets one: its subject,
//                 and a quoted first line of the text it carries
//                 (lib/tool-row/preview.ts).
//   exec-preview  the three context-mode exec tools get a highlighted one-line
//                 command, a status tag and an output digest, and the whole
//                 command and output on expand (lib/tool-row/exec.ts).
//
// why a patch and not a registration. context-mode registers its exec tools
// itself (mcp-bridge.js) with its own renderers, and `getAllRegisteredTools()`
// keeps first-registration-wins by extension load order, so a competing
// registration of the same name either loses silently or wins and then has to
// reimplement the MCP stdio bridge to have anything to execute. patching the
// component is keyed on the running tool name instead, so it applies whoever
// registered the tool, the same way halfblock-boxes.ts patches `render`.
//
// this is one extension rather than two because both behaviours patch the same
// method: two patches would compose by load order, and the second would wrap a
// renderer the first had already replaced.
//
// getCallRenderer, getResultRenderer, toolName and formatToolExecution are
// TS-private on ToolExecutionComponent (plain JS at runtime, the same
// situation halfblock-boxes.ts's BoxInternals reaches past).
// ToolExecutionInternals below names exactly the members reached, rather than
// opening the whole receiver up.
import {
    ToolExecutionComponent,
    highlightCode,
    type AgentToolResult,
    type ExtensionAPI,
    type Theme,
    type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import { config } from './lib/config';
import {
    collapseCall,
    collapseResult,
    expandCall,
    expandResult,
    isExecTool,
    parseExecCall,
    parseExecResult,
} from './lib/tool-row/exec';
import { noteFor } from './lib/tool-row/notes';
import { callPreview, resultPreview } from './lib/tool-row/preview';
import type { RowColor, RowTheme } from './lib/tool-row/theme';
import { retitle, toolTitle } from './lib/tool-row/title';

const { titles, detail, execPreview, names } = config.tools;

if (titles || detail || execPreview) {
    const titleOf = (name: string): string => (titles ? toolTitle(name, names) : name);

    // pi's Theme has fg and bold as methods, and highlightCode as a standalone
    // export rather than a method; this is that shape as RowTheme.
    const adapt = (theme: Theme): RowTheme => ({
        fg: (color: RowColor, text: string) => theme.fg(color, text),
        bold: (text: string) => theme.bold(text),
        highlight: (code: string, language: string) => highlightCode(code, language),
    });

    // pi calls render(width) on every layout pass, including a resize, without
    // rebuilding the component, so anything that depends on the width has to
    // happen there and not at construction.
    class Lines implements Component {
        constructor(private readonly build: (width: number) => string[]) {}
        render(width: number): string[] {
            return this.build(width);
        }
        invalidate(): void {}
    }

    /** a tool's own call component, with the tool name in it replaced. */
    class Retitled implements Component {
        constructor(
            readonly inner: Component,
            private readonly name: string,
            private readonly title: string,
        ) {}
        render(width: number): string[] {
            const lines = this.inner.render(width);
            const first = lines[0];
            if (first === undefined) return lines;
            return [retitle(first, this.name, this.title, width), ...lines.slice(1)];
        }
        invalidate(): void {
            this.inner.invalidate();
        }
        handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
            return this.inner.handleMouse?.(event);
        }
        handleInput(data: string): void {
            this.inner.handleInput?.(data);
        }
    }

    // ToolRenderContext is not exported from the package root; this names only
    // the fields read here.
    interface RenderCtx {
        args: unknown;
        expanded: boolean;
        lastComponent?: Component;
    }

    type RenderCallFn = (args: unknown, theme: Theme, context: RenderCtx) => Component;
    type RenderResultFn = (
        result: AgentToolResult<unknown>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: RenderCtx,
    ) => Component;

    interface ToolExecutionInternals {
        toolName: string;
        getCallRenderer(): RenderCallFn | undefined;
        getResultRenderer(): RenderResultFn | undefined;
        formatToolExecution(): string;
    }

    const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionInternals;

    /** what an identifier in the arguments stands for, e.g. who a channel is. */
    const noteOn = (args: unknown): string | undefined => {
        if (typeof args !== 'object' || args === null) return undefined;
        for (const value of Object.values(args as Record<string, unknown>)) {
            if (typeof value !== 'string') continue;
            const note = noteFor(value);
            if (note !== undefined) return note;
        }
        return undefined;
    };

    const origGetCallRenderer = proto.getCallRenderer;
    proto.getCallRenderer = function (this: ToolExecutionInternals): RenderCallFn | undefined {
        const name = this.toolName;

        if (execPreview && isExecTool(name)) {
            return (args, theme, context) => {
                const call = parseExecCall(name, args);
                if (!call) return new Lines(() => [theme.fg('toolTitle', theme.bold(titleOf(name)))]);
                const rowTheme = adapt(theme);
                if (context.expanded) {
                    const lines = expandCall(call, rowTheme);
                    return new Lines(() => lines);
                }
                return new Lines((width) => [collapseCall(call, width, rowTheme)]);
            };
        }

        const inner = origGetCallRenderer.call(this);

        if (inner === undefined) {
            if (!detail) return inner;
            const title = titleOf(name);
            // the arguments and the expanded flag are read from the context on
            // every call, because both change while the row is on screen: the
            // arguments as the model streams them, the flag as the row opens.
            return (args, theme, context) =>
                new Lines((width) =>
                    callPreview({
                        title,
                        args: context.args ?? args,
                        note: noteOn(context.args ?? args),
                        expanded: context.expanded,
                        width,
                        theme: adapt(theme),
                    }),
                );
        }

        if (!titles) return inner;
        const title = titleOf(name);
        if (title === name) return inner;
        return (args, theme, context) => {
            // the renderer is handed back the component it returned last time,
            // for its own incremental state, so it gets its own one rather than
            // the wrapper around it.
            const last = context.lastComponent;
            const unwrapped = last instanceof Retitled ? last.inner : last;
            return new Retitled(inner(args, theme, { ...context, lastComponent: unwrapped }), name, title);
        };
    };

    /** every text block of a result, joined the way the row would print it. */
    const resultText = (result: AgentToolResult<unknown>): string =>
        (result.content ?? [])
            .filter((c): c is { type: 'text'; text: string } =>
                c.type === 'text' && typeof (c as { text?: unknown }).text === 'string')
            .map((c) => c.text)
            .join('\n');

    const origGetResultRenderer = proto.getResultRenderer;
    proto.getResultRenderer = function (this: ToolExecutionInternals): RenderResultFn | undefined {
        const name = this.toolName;

        if (execPreview && isExecTool(name)) {
            return (result, options, theme, context) => {
                const call = parseExecCall(name, context.args);
                if (!call) return new Lines(() => []);
                if (options.isPartial) return new Lines(() => [theme.fg('warning', 'running\u2026')]);

                const { outcome } = parseExecResult(resultText(result));
                const rowTheme = adapt(theme);

                if (options.expanded) {
                    const lines = expandResult(call, outcome, rowTheme);
                    return new Lines(() => lines);
                }
                return new Lines((width) => {
                    const line = collapseResult(call, outcome, width, rowTheme);
                    return line ? [line] : [];
                });
            };
        }

        const inner = origGetResultRenderer.call(this);
        if (inner !== undefined || !detail) return inner;

        // the same row as the call: a tool that answers by naming what the call
        // already named says nothing here, and the row's colour is the record
        // that it worked.
        return (result, options, theme, context) =>
            new Lines((width) =>
                resultPreview({
                    text: resultText(result),
                    args: context.args,
                    note: noteOn(context.args),
                    expanded: options.expanded,
                    width,
                    theme: adapt(theme),
                }),
            );
    };

    if (titles) {
        // a tool call with no definition at all never reaches a renderer: pi
        // prints its name and a JSON dump as text. the name in it takes the
        // same replacement.
        const origFormat = proto.formatToolExecution;
        proto.formatToolExecution = function (this: ToolExecutionInternals): string {
            const [first, ...rest] = origFormat.call(this).split('\n');
            if (first === undefined) return '';
            return [retitle(first, this.toolName, titleOf(this.toolName)), ...rest].join('\n');
        };
    }
}

export default function (_pi: ExtensionAPI) {}
