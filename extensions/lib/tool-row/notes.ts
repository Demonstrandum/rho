// what an opaque identifier in a tool's arguments stands for.
//
// a tool row shows what it was given: `D0C0PG7LZCJ`, `C07J1N8Q0`, a host key.
// the extension that owns the identifier is the only thing that knows it is
// Adam, and it learns that while doing its own work, not while rendering. so
// it writes what it learns here and tool-titles.ts reads it back when a row
// carries that identifier.
//
// the table lives on globalThis rather than in this module, because /reload
// replaces the module: the extension that wrote a name and the renderer that
// reads it would otherwise hold two different copies of it, and a reload would
// drop every name learnt before it.

const REGISTRY = '__rho_tool_notes';

type Notes = Map<string, string>;

const table = (): Notes => {
    const shared = globalThis as typeof globalThis & { [REGISTRY]?: Notes };
    return (shared[REGISTRY] ??= new Map());
};

/** name an identifier. an empty note removes it. */
export function setNote(value: string, note: string): void {
    if (value === '') return;
    if (note === '') table().delete(value);
    else table().set(value, note);
}

export function noteFor(value: string): string | undefined {
    return table().get(value);
}
