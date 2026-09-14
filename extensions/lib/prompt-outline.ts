// a provider payload, read as a tree.
//
// the payload type is `unknown` (see prompt-log.ts), so nothing here may assume
// anthropic's keys, openai's, or any other provider's. the walk is over JSON
// itself: every property and every array element becomes a node, down to a
// depth, and a node whose value is a string or a number is a leaf. that reaches
// the parts anyone wants (the system text, one message, one content block)
// without naming a single provider field.
//
// the one place shape is guessed at is the label: an element of an array is
// named by the key that holds it plus, when the element carries a `role`,
// `type`, or `name` string, that value. every provider that puts messages in a
// list uses at least one of the three, and an element with none is still
// labelled by its index.
//
// `pretty` is the reason for reading a payload here rather than through
// JSON.stringify: a system prompt is thousands of characters holding newlines,
// and JSON shows them as \n on one unreadable line.

export type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface OutlineNode {
    /** where the value sits, as a javascript expression: `messages[3].content` */
    readonly path: string;
    readonly label: string;
    /** size or shape, for the list's second column */
    readonly detail: string;
    readonly depth: number;
    readonly kind: JsonKind;
    readonly value: unknown;
}

export function kindOf(value: unknown): JsonKind {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') return type;
    return 'object';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** how many characters the whole subtree holds, as a rough weight. */
export function weight(value: unknown): number {
    if (typeof value === 'string') return value.length;
    if (value === null || typeof value !== 'object') return String(value).length;
    if (Array.isArray(value)) return value.reduce<number>((sum, element) => sum + weight(element), 0);
    return Object.entries(value as Record<string, unknown>)
        .reduce((sum, [key, element]) => sum + key.length + weight(element), 0);
}

/** the field an element names itself by, when it has one. */
function hint(value: unknown): string | null {
    if (!isRecord(value)) return null;
    for (const key of ['role', 'type', 'name'] as const) {
        const held = value[key];
        if (typeof held === 'string' && held !== '') return held;
    }
    return null;
}

function detailOf(value: unknown): string {
    const kind = kindOf(value);
    if (kind === 'string') return `${(value as string).length} chars`;
    if (kind === 'array') return `${(value as unknown[]).length} items`;
    if (kind === 'object') {
        const keys = Object.keys(value as Record<string, unknown>);
        return keys.length <= 4 ? keys.join(' ') : `${keys.length} keys`;
    }
    return String(value);
}

/** the singular of a plural container key, for labelling its elements. */
function singular(key: string): string {
    if (key.endsWith('ies')) return `${key.slice(0, -3)}y`;
    if (key.endsWith('s') && !key.endsWith('ss')) return key.slice(0, -1);
    return key;
}

export interface OutlineOptions {
    /** how deep the walk goes before a subtree is left whole. */
    readonly maxDepth?: number;
    /** longest array expanded element by element. */
    readonly maxElements?: number;
}

/**
 * depth-first, parents before children, so the result is a list the reader can
 * scroll and each node's `depth` is its indentation.
 */
export function outline(payload: unknown, options: OutlineOptions = {}): OutlineNode[] {
    const maxDepth = options.maxDepth ?? 4;
    const maxElements = options.maxElements ?? 200;
    const out: OutlineNode[] = [];

    const walk = (value: unknown, path: string, label: string, depth: number): void => {
        out.push({ path, label, detail: detailOf(value), depth, kind: kindOf(value), value });
        if (depth >= maxDepth) return;
        if (Array.isArray(value)) {
            const name = singular(label.split(' ')[0] ?? 'item');
            for (const [index, element] of value.slice(0, maxElements).entries()) {
                const named = hint(element);
                walk(
                    element,
                    `${path}[${index}]`,
                    named === null ? `${name} ${index}` : `${name} ${index}  ${named}`,
                    depth + 1,
                );
            }
            return;
        }
        if (isRecord(value)) {
            for (const [key, held] of Object.entries(value)) {
                walk(held, path === '' ? key : `${path}.${key}`, key, depth + 1);
            }
        }
    };

    if (Array.isArray(payload) || isRecord(payload)) {
        for (const [key, held] of Object.entries(payload as Record<string, unknown>)) {
            walk(held, key, key, 0);
        }
    } else {
        walk(payload, '', 'payload', 0);
    }
    return out;
}

/**
 * the value as text a person reads: a string is printed as itself, over as many
 * lines as it holds, and everything else is printed key by key around its
 * strings. no escaping, no quoting, so the text is what the model receives.
 */
export function pretty(value: unknown, indent = ''): string[] {
    if (typeof value === 'string') return value.split('\n').map((line) => indent + line);
    if (value === null || typeof value !== 'object') return [indent + String(value)];
    if (Array.isArray(value)) {
        const out: string[] = [];
        for (const [index, element] of value.entries()) {
            const label = hint(element);
            out.push(`${indent}[${index}]${label === null ? '' : ` ${label}`}`);
            out.push(...pretty(element, `${indent}  `));
        }
        return out.length === 0 ? [`${indent}(empty)`] : out;
    }
    const out: string[] = [];
    for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
        if (typeof held === 'string' && !held.includes('\n')) {
            out.push(`${indent}${key}: ${held}`);
            continue;
        }
        if (held === null || typeof held !== 'object') {
            out.push(`${indent}${key}: ${String(held)}`);
            continue;
        }
        out.push(`${indent}${key}:`);
        out.push(...pretty(held, `${indent}  `));
    }
    return out.length === 0 ? [`${indent}(empty)`] : out;
}

export function raw(value: unknown): string[] {
    return JSON.stringify(value, null, 2).split('\n');
}
