// what a tool row is called.
//
// pure: no pi imports. the string operations under it (escapes, splicing,
// words) are text.ts.
//
//   toolTitle   a tool name -> the name shown in the row
//   retitle     a rendered line -> the same line with its name replaced
//
// the title is derived rather than listed, because a tool this file has never
// heard of still gets one. derivation is: split the name into words, drop a
// leading namespace, and join them with spaces, lower case throughout, which
// is how pi's own rows read (`read`, `bash`, `exec`). TITLES holds the names
// where that reads wrong, and `[tools] names` in rho.toml overrides any of it.

import { plain, spliceVisible, words } from '../core/text';

/**
 * a namespace a package stamps on every one of its tools. it is dropped when
 * other words remain, since the row already sits in one session and the
 * package is not what the reader is identifying.
 */
const NAMESPACES: ReadonlySet<string> = new Set(['ctx', 'mcp']);

/** names whose derived title would be wrong, rather than merely unusual. */
const TITLES: Readonly<Record<string, string>> = {
    ctx_execute: 'exec',
    ctx_execute_file: 'exec file',
    ctx_batch_execute: 'batch',
};

export function toolTitle(name: string, overrides: Readonly<Record<string, string>> = {}): string {
    const exact = overrides[name] ?? TITLES[name];
    if (exact !== undefined) return exact;
    const parts = words(name);
    if (parts.length === 0) return name;
    const first = parts[0]!.toLowerCase();
    const kept = parts.length > 1 && NAMESPACES.has(first) ? parts.slice(1) : parts;
    return kept.map((word) => word.toLowerCase()).join(' ');
}

/**
 * replace the tool name at the head of a rendered line with `title`, keeping
 * the escape sequences around it, so the title inherits whatever styling the
 * renderer gave the name.
 *
 * the name must be the first word of the line: a renderer that writes it
 * elsewhere is describing something other than the row's subject, and the line
 * comes back unchanged. `budget`, when given, is the width the line is drawn
 * at, and a substitution that would overflow it is declined.
 */
export function retitle(line: string, name: string, title: string, budget?: number): string {
    if (name === title) return line;
    const bare = plain(line);
    const at = bare.indexOf(name);
    if (at < 0) return line;
    // only leading decoration may precede it, and the match must end the word.
    if (/[A-Za-z0-9]/.test(bare.slice(0, at))) return line;
    if (/[A-Za-z0-9_]/.test(bare.charAt(at + name.length))) return line;
    if (budget !== undefined && bare.length + title.length - name.length > budget) return line;
    return spliceVisible(line, at, at + name.length, title);
}
