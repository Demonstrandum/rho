/**
 * What `/prompt` shows, as views rather than as components.
 *
 * These were three `ctx.ui.custom` calls in prompt-inspect.ts: a list of
 * captured requests, an outline of one payload, and a pager over a node of it
 * with a raw-json switch. Each one built its own SelectList, wrote its own hint
 * line, and could be drawn in exactly one place, which is why `/prompt` on a
 * session running on another machine drew nothing at all.
 *
 * Described this way they are data, so the same three views work in this
 * terminal, over a link, and in anything else that learns the model. The
 * pi-tui parts of them now live once, in `view/terminal.ts`.
 */

import { declare } from './view/registry';
import type { DocumentView, Line, ListView, ViewComponent } from './view/model';
import type { CapturedRequest } from './prompt-log';
import { type OutlineNode, outline, pretty, raw, weight } from './prompt-outline';
import { truncate } from './text';

const OWNER = 'prompt-inspect';

export const REQUEST_LIST = declare({
    owner: OWNER,
    name: 'request-list',
    purpose: 'the provider requests this session has sent',
    renderings: ['view'],
});

export const PAYLOAD_OUTLINE = declare({
    owner: OWNER,
    name: 'payload-outline',
    purpose: 'one provider payload, property by property',
    renderings: ['view'],
});

export const PAYLOAD_TEXT = declare({
    owner: OWNER,
    name: 'payload-text',
    purpose: 'the text of one part of a payload',
    renderings: ['view'],
});

export const requestTitle = (request: CapturedRequest, at: string): Line => [
    { text: `request ${request.ordinal}` },
    { text: `  ${at}`, tone: 'dim' },
];

/** Pick one of the captured requests. The answer is its ordinal. */
export function requestList(
    requests: readonly CapturedRequest[],
    stamp: (at: number) => string,
): ViewComponent<number | null> {
    return {
        spec: REQUEST_LIST,
        onDismiss: null,
        open: (): ListView => ({
            kind: 'list',
            title: `provider requests (${requests.length})`,
            choose: 'open',
            empty: 'nothing sent yet; run a turn and the request is here',
            items: requests.map((request) => ({
                id: String(request.ordinal),
                label: requestTitle(request, stamp(request.at)),
                description: `${weight(request.payload)} chars`,
            })),
        }),
        react: (event) =>
            event.kind === 'activate' ? { kind: 'done', result: Number(event.item) } : { kind: 'ignore' },
    };
}

/** Browse one payload. The answer is the node to open, by index. */
export function payloadOutline(title: Line, nodes: readonly OutlineNode[]): ViewComponent<number | null> {
    return {
        spec: PAYLOAD_OUTLINE,
        onDismiss: null,
        open: (): ListView => ({
            kind: 'list',
            title,
            choose: 'open',
            items: nodes.map((node, index) => ({
                id: String(index),
                label: `${'  '.repeat(node.depth)}${truncate(node.label, 44)}`,
                description: [{ text: node.kind, tone: 'muted' }, { text: `  ${node.detail}`, tone: 'dim' }],
            })),
        }),
        react: (event) =>
            event.kind === 'activate' ? { kind: 'done', result: Number(event.item) } : { kind: 'ignore' },
    };
}

/**
 * Text with a switch between what it says and what it is.
 *
 * The raw-json toggle was a key the pager knew about and the hint line
 * repeated. As a toggle it is one declaration, and a front end with no
 * keyboard gets a switch it can draw as a switch.
 */
export function payloadText(title: Line, value: unknown, alsoRaw: boolean): ViewComponent<null> {
    const build = (asJson: boolean): DocumentView => ({
        kind: 'document',
        title,
        preformatted: true,
        lines: asJson ? raw(value) : pretty(value),
        ...(alsoRaw ? { toggles: [{ id: 'raw', label: 'raw json', on: asJson, key: 'r' }] } : {}),
    });
    let asJson = false;
    return {
        spec: PAYLOAD_TEXT,
        onDismiss: null,
        open: () => build(asJson),
        react: (event) => {
            if (event.kind !== 'toggle' || event.toggle !== 'raw') return { kind: 'ignore' };
            asJson = event.on;
            return { kind: 'update', view: build(asJson) };
        },
    };
}

/** Plain text, with nothing to switch: the system prompt, a dump, a refusal. */
export function textView(title: Line, lines: readonly string[]): ViewComponent<null> {
    return {
        spec: PAYLOAD_TEXT,
        onDismiss: null,
        open: (): DocumentView => ({ kind: 'document', title, preformatted: true, lines }),
    };
}

export { outline };
export type { OutlineNode };
