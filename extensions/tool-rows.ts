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
import { Box, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import { trimBlankEdges } from './lib/box-edges';
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
import { truncate, visibleWidth } from './lib/text';
import { noteFor } from './lib/tool-row/notes';
import { callPreview, resultPreview } from './lib/tool-row/preview';
import type { RowColor, RowTheme } from './lib/tool-row/theme';
import { retitle, toolTitle } from './lib/tool-row/title';

const { titles, detail, execPreview, names } = config.tools;
const { selfRenderedRows } = config.render;

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

// ToolRenderContext is not exported from the package root; this names only
// the fields read here.
interface RenderCtx {
    args: unknown;
    expanded: boolean;
    lastComponent?: Component;
    /** set on a result context only; AgentToolResult does not carry it. */
    isError?: boolean;
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
    getRenderShell(): RenderShell;
    formatToolExecution(): string;
}

type RenderShell = 'default' | 'self';

/** the tools pi declares `renderShell: "self"` on. */
const SELF_SHELL_TOOLS: ReadonlySet<string> = new Set(['edit']);

if (titles || detail || execPreview) {
    const titleOf = (name: string): string => (titles ? toolTitle(name, names) : name);

    // pi's Theme has fg and bold as methods, and highlightCode as a standalone
    // export rather than a method; this is that shape as RowTheme.
    const adapt = (theme: Theme): RowTheme => ({
        fg: (color: RowColor, text: string) => theme.fg(color, text),
        bold: (text: string) => theme.bold(text),
        highlight: (code: string, language: string) => highlightCode(code, language),
    });

    /**
     * a tool's own call component, with the machine it acted on on the right.
     *
     * a class rather than an object literal because pi hands a renderer the
     * component it returned last time, for that component's own incremental
     * state: returning a fresh wrapper each render left pi's row with no
     * history of itself, and it drew only its title -- the bare "bash" that
     * appeared for every remote call.
     */
    class Marked implements Component {
        constructor(
            readonly inner: Component,
            private readonly where: string,
            private readonly rowTheme: RowTheme,
        ) {}
        render(width: number): string[] {
            const lines = this.inner.render(width);
            const first = lines[0];
            if (first === undefined) return lines;
            const tag = this.rowTheme.fg('dim', truncate(`(${this.where})`, Math.max(4, width - 10)));
            const tagWidth = visibleWidth(tag);
            // the row a tool draws is padded to the full width, so the
            // trailing space is measured as content: trimming it first is what
            // stops a line that fits being truncated to make room.
            const head = first.trimEnd();
            const room = Math.max(4, width - tagWidth - 1);
            const shown = visibleWidth(head) > room ? truncate(head, room) : head;
            const pad = Math.max(1, width - visibleWidth(shown) - tagWidth);
            return [`${shown}${' '.repeat(pad)}${tag}`, ...lines.slice(1)];
        }
        invalidate(): void {
            this.inner.invalidate();
        }
        handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
            return this.inner.handleMouse?.(event);
        }
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

    /**
     * The machine a call acted on, when it is not the session's own.
     *
     * `on` is passed only to send one command somewhere other than the current
     * environment, and an addressed path carries its machine in the path, so
     * the presence of either is the signal. A call that went elsewhere is
     * otherwise identical on screen to one that did not.
     */
    const whereOf = (args: unknown): string | undefined => {
        if (typeof args !== 'object' || args === null) return undefined;
        const on = (args as { on?: unknown }).on;
        if (typeof on === 'string' && on.trim() !== '') return on.trim();
        const path = (args as { path?: unknown }).path;
        if (typeof path === 'string') {
            const addressed = /^([A-Za-z0-9._-]+@[A-Za-z0-9._-]{2,}|local):\//.exec(path);
            if (addressed !== null) return addressed[1];
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
                    // Width per render, not once: a resize has to rewrap, and a
                    // line wider than the terminal crashes pi outright.
                    return new Lines((width) => expandCall(call, rowTheme, width));
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
                        where: whereOf(context.args ?? args),
                        expanded: context.expanded,
                        width,
                        theme: adapt(theme),
                    }),
                );
        }

        // A tool that draws its own row, acting on another machine: the
        // machine goes on the right of its first line. pi renders bash itself,
        // so the callPreview path above never sees it, and without this the
        // only sign of where a command ran was a marker line pushed into the
        // output, which is noise in the model's context and ugly on screen.
        const title = titles ? titleOf(name) : name;
        if (title === name) {
            return (args, theme, context) => {
                const where = whereOf(context.args ?? args);
                const last = context.lastComponent;
                const unwrapped = last instanceof Marked ? last.inner : last;
                const component = inner(args, theme, { ...context, lastComponent: unwrapped });
                return where === undefined ? component : new Marked(component, where, adapt(theme));
            };
        }
        return (args, theme, context) => {
            // the renderer is handed back the component it returned last time,
            // for its own incremental state, so it gets its own one rather than
            // the wrapper around it.
            const last = context.lastComponent;
            // two layers, so each unwraps to the component pi's own renderer
            // made: a wrapper handed back as history is a component that never
            // sees its own past, and a row that cannot see its past draws only
            // its title.
            const outer = last instanceof Marked ? last.inner : last;
            const unwrapped = outer instanceof Retitled ? outer.inner : outer;
            const retitled = new Retitled(inner(args, theme, { ...context, lastComponent: unwrapped }), name, title);
            const where = whereOf(context.args ?? args);
            return where === undefined ? retitled : new Marked(retitled, where, adapt(theme));
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
                    return new Lines((width) => expandResult(call, outcome, rowTheme, width));
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

if (selfRenderedRows) {
    // pi's edit tool is the only one that declares renderShell "self": it draws
    // its own row rather than letting ToolExecutionComponent wrap its output in
    // the usual Box, because the row has to keep a diff on screen while the
    // arguments are still streaming and rewrite it in place when they settle.
    // two things go wrong with that row, and both are repaired here rather than
    // by changing what the tool draws.
    //
    // the shell is lost. a definition reaches the component through
    // wrapToolDefinition, which copies name, label, description, parameters,
    // constrainedSampling, prepareArguments, executionMode and execute, and
    // then through withBuiltInRenderers, which rebuilds it as `{...definition,
    // renderCall, renderResult}`. neither carries renderShell, so
    // getRenderShell() answers "default" and pi wraps the box the tool drew in
    // its own contentBox: the row is boxed twice, one frame inside the other,
    // and the inner frame is invisible until a selection inverts it.
    //
    // the result lands outside the box. edit's result slot
    // (core/tools/renderers/edit.js) returns a bare Container of a Spacer and a
    // Text, which comes after the box: an unpainted blank line and an unpainted
    // line of text. it is reached whenever the result differs from the preview
    // already drawn, which in practice is every failed edit. so the tail is
    // trimmed and put in a Box of its own, which picks up halfblock-boxes.ts's
    // patch on Box.prototype.render for free.
    const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionInternals;

    const origGetRenderShell = proto.getRenderShell;
    proto.getRenderShell = function (this: ToolExecutionInternals): RenderShell {
        const shell = origGetRenderShell.call(this);
        // a pi that stops dropping renderShell answers "self" here already, and
        // this leaves it alone.
        if (shell !== 'default' || !SELF_SHELL_TOOLS.has(this.toolName)) return shell;
        return 'self';
    };

    /** a self-rendered tool's trailing output, in a box of its own. */
    class Tail extends Box {
        constructor(readonly inner: Component, bg: (text: string) => string) {
            super(0, 1, bg);
            // Box.render returns [] when its children render nothing, so a tool
            // that says nothing here still costs no rows.
            this.addChild(new Lines((width) => trimBlankEdges(inner.render(width))));
        }
        // Box.invalidate walks its children, and Lines holds the real component
        // in a closure rather than as one.
        invalidate(): void {
            super.invalidate();
            this.inner.invalidate?.();
        }
    }

    const origGetResultRenderer = proto.getResultRenderer;
    proto.getResultRenderer = function (this: ToolExecutionInternals): RenderResultFn | undefined {
        const inner = origGetResultRenderer.call(this);
        if (inner === undefined || this.toolName !== 'edit') return inner;

        return (result, options, theme, context) => {
            // pi hands a renderer the component it returned last time for its
            // own incremental state, and edit's clears and refills it, so it
            // gets the component it made rather than the wrapper around it.
            const last = context.lastComponent;
            const prior = last instanceof Tail ? last.inner : last;
            const component = inner(result, options, theme, { ...context, lastComponent: prior });
            const bg = (text: string) => theme.bg(context.isError ? 'toolErrorBg' : 'toolSuccessBg', text);
            if (last instanceof Tail && last.inner === component) {
                last.setBgFn(bg);
                return last;
            }
            return new Tail(component, bg);
        };
    };
}

export default function (_pi: ExtensionAPI) {}
