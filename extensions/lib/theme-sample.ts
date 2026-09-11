// a session that never happened, drawn by the components that draw the real one.
//
// a theme is chosen on how a session looks, so the preview is not a painting of
// one: it is pi's own UserMessageComponent, AssistantMessageComponent and
// ToolExecutionComponent, holding fixed content. every colour token a
// transcript uses arrives through the code that normally puts it there, the
// markdown goes through pi's markdown theme, the read row goes through pi's
// read renderer, and the rows this package changes go through those changes.
// nothing here can drift from the real thing, because there is no second
// implementation to drift.
//
// what it holds: a question, a thinking block, a tool row pi draws, a tool row
// with no renderer of its own (which tool-rows.ts fills in), and a reply with a
// heading, a list, inline code and a diff.

import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
    AssistantMessageComponent,
    type ToolDefinition,
    createReadToolDefinition,
    getMarkdownTheme,
    ToolExecutionComponent,
    UserMessageComponent,
} from '@earendil-works/pi-coding-agent';
import { Container, type Component, type TUI } from '@earendil-works/pi-tui';

/**
 * the renderer pair ToolExecutionComponent accepts in place of a definition.
 * pi does not export the type, and an empty one is what a tool with no
 * renderers of its own looks like, which is the row tool-rows.ts fills in.
 */
type ToolRenderers = Record<string, never>;

const QUESTION = 'why is the footer a column short after a resize?';

const THINKING = [
    'the width comes from the last render, so a shrink is measured against the',
    'old value. the arrow glyphs are two cells wide in that font, which is where',
    'the missing column goes.',
].join('\n');

const REPLY = [
    '## the fix',
    '',
    '`FooterComponent.render` measures with the **previous** width, so the first',
    'frame after a resize is off by the difference.',
    '',
    '- the measurement moves into the render pass',
    '- the cached width is dropped on `resize`',
].join('\n');

const READ_PATH = 'extensions/footer.ts';

const READ_RESULT = [
    '   143 function formatCwd(cwd: string, home: string | undefined): string {',
    '   144     const rel = relative(resolve(home), resolve(cwd));',
    '   145     return rel === "" ? "~" : `~${sep}${rel}`;',
    '   146 }',
].join('\n');

/** a message shaped the way a provider returns one, with nothing spent. */
function assistantMessage(): AssistantMessage {
    return {
        role: 'assistant',
        content: [
            { type: 'thinking', thinking: THINKING },
            { type: 'text', text: REPLY },
        ],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'sample',
        usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
    } as AssistantMessage;
}

function toolRow(
    tui: TUI,
    cwd: string,
    name: string,
    args: unknown,
    result: string,
    definition: ToolDefinition<any, any, any> | ToolRenderers,
): ToolExecutionComponent {
    const row = new ToolExecutionComponent(name, `sample-${name}`, args, undefined, definition, tui, cwd);
    row.setArgsComplete();
    row.markExecutionStarted();
    row.updateResult({ content: [{ type: 'text', text: result }], isError: false }, false);
    return row;
}

export interface SampleOptions {
    tui: TUI;
    cwd: string;
}

export interface Sample {
    /** the question, which the picker pins so it is never the part clipped. */
    opening: Component;
    /** the rest of the exchange, read from its end the way a session is. */
    body: Component;
}

/**
 * the sample transcript. it is rebuilt per preview rather than themed in place:
 * pi's components take their colours as they build their lines, so a theme
 * change is a new build.
 */
export function sampleSession(options: SampleOptions): Sample {
    const { tui, cwd } = options;
    const opening = new Container();
    opening.addChild(new UserMessageComponent(QUESTION, getMarkdownTheme()));

    const container = new Container();
    // pi's own read renderer: the file header, the line numbers, the highlight.
    container.addChild(toolRow(
        tui, cwd, 'read',
        { file_path: READ_PATH, offset: 143, limit: 4 },
        READ_RESULT,
        createReadToolDefinition(cwd),
    ));

    // a tool that ships no renderer of its own, which is the row tool-rows.ts
    // draws: the display name, the subject, and the message under it.
    container.addChild(toolRow(
        tui, cwd, 'slack_reply',
        { channel: 'D0C0PG7LZCJ', text: 'found it: the footer measures against the width it had before the resize' },
        'Sent to D0C0PG7LZCJ.',
        {},
    ));

    container.addChild(new AssistantMessageComponent(assistantMessage(), false, getMarkdownTheme()));
    return { opening, body: container };
}
