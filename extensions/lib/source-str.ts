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

// wrap key-value entries from a JSON file as [SourceStr, SourceStr][]
// by scanning the raw JSON text for line:col positions.
export function wrapEntries(
    entries: [string, string][],
    file: string,
    jsonText: string,
    section: string,
): [SourceStr, SourceStr][] {
    const lines = jsonText.split('\n');
    const positions: Record<string, { kl: number; kc: number; vl: number; vc: number }> = {};

    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const m = ln.match(/^(\s*)"([^"]+)"\s*:\s*"/);
        if (!m) continue;
        const key = m[1].length; // indent length
        const keyStr = m[2];
        const kc = ln.indexOf(`"${keyStr}"`) + 2; // 1-indexed, inside quote
        const colonIdx = ln.indexOf(':', kc);
        const vc = ln.indexOf('"', colonIdx + 1) + 2; // 1-indexed, inside quote
        positions[keyStr] = { kl: i + 1, kc, vl: i + 1, vc };
    }

    return entries.map(([k, v]) => {
        const pos = positions[k];
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
