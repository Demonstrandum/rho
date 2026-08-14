// a String subclass that carries source provenance. when interpolated
// in a template literal, embeds invisible markers (\x00meta\x01value\x02)
// that downstream code can either strip (runtime prompt) or parse
// (explorer spans).
//
// the same template expression works for both:
//   runtime:  words = [["tapestry", "big rug"], ...]  -> clean output
//   explorer: words = [[SourceStr(...), SourceStr(...)], ...] -> marked output

export interface SourceMeta {
    file: string;
    line: number;
    col: number;
    path?: string;
}

const M0 = '\x00'; // start marker
const M1 = '\x01'; // separator (meta | value)
const M2 = '\x02'; // end marker

export class SourceStr extends String {
    readonly meta: SourceMeta;

    constructor(value: string, meta: SourceMeta) {
        super(value);
        this.meta = meta;
    }

    override toString(): string {
        return `${M0}${JSON.stringify(this.meta)}${M1}${super.valueOf()}${M2}`;
    }

    [Symbol.toPrimitive](): string {
        return this.toString();
    }
}

// strip markers, leaving plain text.
const MARKER_RE = /\x00[^\x01]*\x01([^\x02]*)\x02/g;

export function stripMarkers(text: string): string {
    return text.replace(MARKER_RE, '$1');
}

export function hasMarkers(text: string): boolean {
    return text.includes(M0);
}

// parse a marked string into spans. unmarked text gets source = null.
export interface Span {
    text: string;
    source: SourceMeta | null;
}

export function parseSpans(text: string): Span[] {
    const spans: Span[] = [];
    const re = new RegExp(`${M0}([^${M1}]*)${M1}([^${M2}]*)${M2}`, 'g');
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
            spans.push({ text: text.slice(last, m.index), source: null });
        }
        spans.push({ text: m[2], source: JSON.parse(m[1]) as SourceMeta });
        last = m.index + m[0].length;
    }
    if (last < text.length) {
        spans.push({ text: text.slice(last), source: null });
    }
    return spans;
}

// embed a single marker inline (for building pre-marked strings).
export function mark(value: string, meta: SourceMeta): string {
    return `${M0}${JSON.stringify(meta)}${M1}${value}${M2}`;
}

// scan forward from a line to find string value positions inside an
// array or object. skips keys (strings followed by ':').
function scanStringPositions(
    jsonLines: string[],
    startLine: number,
): { line: number; col: number; text: string }[] {
    const results: { line: number; col: number; text: string }[] = [];
    let depth = 0;
    let started = false;
    for (let i = startLine; i < jsonLines.length; i++) {
        const ln = jsonLines[i];
        for (let j = 0; j < ln.length; j++) {
            const ch = ln[j];
            if (ch === '[' || ch === '{') { depth++; started = true; }
            if (ch === ']' || ch === '}') { depth--; if (started && depth <= 0) return results; }
            if (ch === '"') {
                let end = j + 1;
                while (end < ln.length && ln[end] !== '"') {
                    if (ln[end] === '\\') end++;
                    end++;
                }
                const raw = ln.slice(j + 1, end);
                const unescaped = raw.replace(/\\(.)/g, '$1');
                const afterQuote = ln.slice(end + 1).trimStart();
                if (!afterQuote.startsWith(':')) {
                    results.push({ line: i + 1, col: j + 2, text: unescaped });
                }
                j = end;
            }
        }
    }
    return results;
}

// wrap entries from a raw JSON dict. handles string, array, and object
// values. arrays and objects produce pre-marked strings with per-element
// markers so each component traces to its exact JSON position.
export function wrapRawDict(
    dict: Record<string, unknown>,
    file: string,
    jsonText: string,
    section: string,
): [SourceStr | string, SourceStr | string][] {
    const jsonLines = jsonText.split('\n');
    const keyPos: Record<string, { line: number; col: number }> = {};
    for (let i = 0; i < jsonLines.length; i++) {
        const m = jsonLines[i].match(/^\s*"((?:[^"\\]|\\.)*)"\s*:/);
        if (!m) continue;
        const raw = m[1];
        const unesc = raw.replace(/\\(.)/g, '$1');
        const col = jsonLines[i].indexOf(`"${raw}"`) + 2;
        keyPos[unesc] = { line: i + 1, col };
        if (raw !== unesc) keyPos[raw] = { line: i + 1, col };
    }

    const result: [SourceStr | string, SourceStr | string][] = [];

    for (const [key, value] of Object.entries(dict)) {
        const kp = keyPos[key];
        const wrappedKey = new SourceStr(key, {
            file, line: kp?.line ?? 0, col: kp?.col ?? 0,
            path: `${section} key`,
        });

        if (typeof value === 'string') {
            const ln = kp ? jsonLines[kp.line - 1] : '';
            const colonIdx = ln.indexOf(':', (kp?.col ?? 0));
            const vc = colonIdx >= 0 ? ln.indexOf('"', colonIdx + 1) : -1;
            result.push([
                wrappedKey,
                new SourceStr(value, {
                    file, line: kp?.line ?? 0, col: vc >= 0 ? vc + 2 : 0,
                    path: `${section}["${key}"]`,
                }),
            ]);
        } else if (Array.isArray(value)) {
            const elems = scanStringPositions(jsonLines, (kp?.line ?? 1) - 1);
            const parts = elems.map((e, i) =>
                mark(e.text, { file, line: e.line, col: e.col, path: `${section}["${key}"][${i}]` }),
            );
            result.push([wrappedKey, parts.join(' | ')]);
        } else if (typeof value === 'object' && value !== null && 'verb' in value) {
            const verbStrings = scanStringPositions(jsonLines, (kp?.line ?? 1) - 1);
            const vObj = value as { verb: string | string[] };
            const templates = Array.isArray(vObj.verb) ? vObj.verb : [vObj.verb];
            const parts: string[] = [];
            for (let ti = 0; ti < templates.length && ti < verbStrings.length; ti++) {
                parts.push(mark(verbStrings[ti].text, {
                    file, line: verbStrings[ti].line, col: verbStrings[ti].col,
                    path: `${section}["${key}"].verb${templates.length > 1 ? `[${ti}]` : ''}`,
                }));
            }
            const markedKey = mark(key, {
                file, line: kp?.line ?? 0, col: kp?.col ?? 0,
                path: `${section} key`,
            }) + ' (all forms)';
            result.push([markedKey, parts.join('" | "')]);
        } else {
            result.push([wrappedKey, String(value)]);
        }
    }

    return result;
}

// backward compat: simple [string, string][] entries.
export function wrapEntries(
    entries: [string, string][],
    file: string,
    jsonText: string,
    section: string,
): [SourceStr, SourceStr][] {
    const jsonLines = jsonText.split('\n');
    // map from raw JSON key (with escapes) to position.
    // also store the unescaped key for lookup from flattened entries.
    const positions: Record<string, { kl: number; kc: number; vl: number; vc: number }> = {};

    for (let i = 0; i < jsonLines.length; i++) {
        const ln = jsonLines[i];
        // match "key": at the start of a line (after indent)
        const m = ln.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:/);
        if (!m) continue;
        const rawKey = m[1];
        // unescape JSON string escapes (\\->\ etc.) for the lookup key
        const unescaped = rawKey.replace(/\\(.)/g, '$1');
        const kc = ln.indexOf(`"${rawKey}"`) + 2;
        const colonIdx = ln.indexOf(':', kc);
        const vc = ln.indexOf('"', colonIdx + 1);
        const vcFinal = vc >= 0 ? vc + 2 : 0;
        const pos = { kl: i + 1, kc, vl: i + 1, vc: vcFinal };
        positions[unescaped] = pos;
        if (rawKey !== unescaped) positions[rawKey] = pos;
    }

    return entries.map(([k, v]) => {
        const pos = positions[k] ?? positions[k.replace(/ \(all forms\)$/, '')];
        return [
            new SourceStr(k, {
                file, line: pos?.kl ?? 0, col: pos?.kc ?? 0,
                path: `${section} key`,
            }),
            new SourceStr(v, {
                file, line: pos?.vl ?? 0, col: pos?.vc ?? 0,
                path: `${section}["${k}"]`,
            }),
        ];
    });
}
