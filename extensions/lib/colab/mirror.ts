// What a marimo session looks like from its message stream.
//
// A kernel talks to its frontends over one websocket, in operations: a
// `kernel-ready` with every cell's id, code and name, then a `cell-op` each
// time a cell's status or output changes, and `variables` / `variable-values`
// as the namespace moves. A read-only (kiosk) connection receives the same
// stream, so a listener that is not the editor can still hold a current
// picture of the notebook. This is that picture: cells in order, each with
// its status and its last error, and a count of what is running.
//
// Pure: fed message objects, asked questions. The socket is session.ts.

export type CellStatus = 'idle' | 'queued' | 'running' | 'disabled-transitively' | 'stale' | 'unknown';

export interface MirrorCell {
    readonly id: string;
    code: string;
    name: string;
    status: CellStatus;
    /** set when the last cell-op carried an error output; cleared by a clean one. */
    error: string | null;
    /** whether the last op left a non-empty display output. */
    hasOutput: boolean;
    stale: boolean;
}

export interface Variable {
    readonly name: string;
    readonly declaredBy: readonly string[];
    readonly usedBy: readonly string[];
    datatype?: string;
    value?: string | null;
}

interface KernelReady {
    cell_ids: string[];
    codes: string[];
    names: string[];
}

interface CellOp {
    cell_id: string;
    status?: CellStatus | null;
    output?: { mimetype?: string; data?: unknown; channel?: string } | null;
    stale_inputs?: boolean | null;
}

/** who changed the document: the browser, the kernel, an agent through cm, the file on disk. */
export type ChangeSource = 'frontend' | 'kernel' | 'code-mode' | 'file-watch' | 'cell-manager' | 'unknown';

export interface Activity {
    readonly at: number;
    readonly source: ChangeSource;
    readonly kind: string;
    readonly cellId: string | null;
}

const ACTIVITY_KEEP = 200;

const errorText = (output: CellOp['output']): string | null => {
    if (output === null || output === undefined) return null;
    if (output.mimetype !== 'application/vnd.marimo+error') return null;
    const data = output.data;
    if (Array.isArray(data)) {
        return data
            .map((entry) => {
                const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
                const type = typeof e.exception_type === 'string' ? e.exception_type : typeof e.type === 'string' ? e.type : 'error';
                const msg = typeof e.msg === 'string' ? e.msg : JSON.stringify(entry);
                return `${type}: ${msg}`;
            })
            .join('\n');
    }
    return typeof data === 'string' ? data : JSON.stringify(data);
};

export class NotebookMirror {
    private readonly cells = new Map<string, MirrorCell>();
    private order: string[] = [];
    private readonly variables = new Map<string, Variable>();
    /** document changes, newest last, for whoever wants to know what moved. */
    private readonly activity: Activity[] = [];
    /** how many ops have been applied, so a listener can tell it moved. */
    version = 0;
    ready = false;

    /** feed one decoded websocket message. unknown ops are ignored. */
    apply(message: unknown): void {
        if (typeof message !== 'object' || message === null) return;
        const envelope = message as { op?: string; data?: unknown };
        const data = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}) as Record<string, unknown>;
        switch (envelope.op) {
            case 'kernel-ready':
                this.onReady(data as unknown as KernelReady);
                break;
            case 'cell-op':
                this.onCellOp(data as unknown as CellOp);
                break;
            case 'variables':
                this.onVariables(data.variables);
                break;
            case 'variable-values':
                this.onValues(data.variables);
                break;
            case 'notebook-document-transaction':
                this.onTransaction(data.transaction);
                break;
            default:
                return;
        }
        this.version += 1;
    }

    private onReady(ready: KernelReady): void {
        if (!Array.isArray(ready.cell_ids)) return;
        const keep = new Set(ready.cell_ids);
        for (const id of [...this.cells.keys()]) if (!keep.has(id)) this.cells.delete(id);
        this.order = [...ready.cell_ids];
        ready.cell_ids.forEach((id, index) => {
            const known = this.cells.get(id);
            const code = ready.codes?.[index] ?? '';
            const name = ready.names?.[index] ?? '';
            if (known === undefined) {
                this.cells.set(id, { id, code, name, status: 'idle', error: null, hasOutput: false, stale: false });
            } else {
                known.code = code;
                known.name = name;
            }
        });
        this.ready = true;
    }

    private onCellOp(op: CellOp): void {
        if (typeof op.cell_id !== 'string') return;
        // an op for a cell the document has not announced is the scratchpad
        // or a cell mid-creation; the transaction that follows will add it.
        const cell = this.cells.get(op.cell_id);
        if (cell === undefined) return;
        if (op.status !== undefined && op.status !== null) cell.status = op.status;
        if (op.stale_inputs !== undefined && op.stale_inputs !== null) cell.stale = op.stale_inputs;
        if (op.output !== undefined && op.output !== null) {
            const error = errorText(op.output);
            cell.error = error;
            const data = op.output.data;
            cell.hasOutput = error === null && data !== undefined && data !== null && data !== '';
        }
    }

    /**
     * a structural change, from whichever side made it. the shapes are
     * marimo's document ops, camel-cased over the wire and tagged by `type`.
     */
    private onTransaction(raw: unknown): void {
        if (typeof raw !== 'object' || raw === null) return;
        const tx = raw as { changes?: unknown; source?: string };
        const source: ChangeSource = ['frontend', 'kernel', 'code-mode', 'file-watch', 'cell-manager'].includes(tx.source ?? '') ? (tx.source as ChangeSource) : 'unknown';
        if (!Array.isArray(tx.changes)) return;
        for (const entry of tx.changes) {
            const change = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
            const kind = typeof change.type === 'string' ? change.type : 'change';
            const cellId = typeof change.cellId === 'string' ? change.cellId : null;
            switch (kind) {
                case 'create-cell': {
                    if (cellId === null) break;
                    const cell: MirrorCell = {
                        id: cellId,
                        code: typeof change.code === 'string' ? change.code : '',
                        name: typeof change.name === 'string' ? change.name : '',
                        status: 'idle',
                        error: null,
                        hasOutput: false,
                        stale: false,
                    };
                    this.cells.set(cellId, cell);
                    this.place(cellId, change);
                    break;
                }
                case 'delete-cell':
                    if (cellId === null) break;
                    this.cells.delete(cellId);
                    this.order = this.order.filter((id) => id !== cellId);
                    break;
                case 'move-cell':
                    if (cellId === null) break;
                    this.place(cellId, change);
                    break;
                case 'reorder-cells': {
                    const ids = Array.isArray(change.cellIds) ? change.cellIds.map(String).filter((id) => this.cells.has(id)) : [];
                    const rest = this.order.filter((id) => !ids.includes(id));
                    this.order = [...ids, ...rest];
                    break;
                }
                case 'set-code': {
                    const cell = cellId === null ? undefined : this.cells.get(cellId);
                    if (cell !== undefined && typeof change.code === 'string') cell.code = change.code;
                    break;
                }
                case 'set-name': {
                    const cell = cellId === null ? undefined : this.cells.get(cellId);
                    if (cell !== undefined && typeof change.name === 'string') cell.name = change.name;
                    break;
                }
                default:
                    break;
            }
            this.activity.push({ at: Date.now(), source, kind, cellId });
            if (this.activity.length > ACTIVITY_KEEP) this.activity.shift();
        }
    }

    /** put a cell where a create or move says, or at the end. */
    private place(cellId: string, change: Record<string, unknown>): void {
        this.order = this.order.filter((id) => id !== cellId);
        const before = typeof change.before === 'string' ? this.order.indexOf(change.before) : -1;
        const after = typeof change.after === 'string' ? this.order.indexOf(change.after) : -1;
        if (before >= 0) this.order.splice(before, 0, cellId);
        else if (after >= 0) this.order.splice(after + 1, 0, cellId);
        else this.order.push(cellId);
    }

    /** changes since a moment, newest last. */
    activitySince(at: number): Activity[] {
        return this.activity.filter((a) => a.at > at);
    }

    private onVariables(list: unknown): void {
        if (!Array.isArray(list)) return;
        const seen = new Set<string>();
        for (const entry of list) {
            const v = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
            if (typeof v.name !== 'string') continue;
            seen.add(v.name);
            const known = this.variables.get(v.name);
            const next: Variable = {
                name: v.name,
                declaredBy: Array.isArray(v.declared_by) ? v.declared_by.map(String) : [],
                usedBy: Array.isArray(v.used_by) ? v.used_by.map(String) : [],
                datatype: known?.datatype,
                value: known?.value,
            };
            this.variables.set(v.name, next);
        }
        for (const name of [...this.variables.keys()]) if (!seen.has(name)) this.variables.delete(name);
    }

    private onValues(list: unknown): void {
        if (!Array.isArray(list)) return;
        for (const entry of list) {
            const v = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
            if (typeof v.name !== 'string') continue;
            const known = this.variables.get(v.name) ?? { name: v.name, declaredBy: [], usedBy: [] };
            known.datatype = typeof v.datatype === 'string' ? v.datatype : known.datatype;
            known.value = v.value === undefined ? known.value : v.value === null ? null : String(v.value);
            this.variables.set(v.name, known);
        }
    }

    list(): MirrorCell[] {
        return this.order.map((id) => this.cells.get(id)).filter((c): c is MirrorCell => c !== undefined);
    }

    cell(id: string): MirrorCell | undefined {
        return this.cells.get(id);
    }

    vars(): Variable[] {
        return [...this.variables.values()];
    }

    get running(): number {
        let n = 0;
        for (const c of this.cells.values()) if (c.status === 'running' || c.status === 'queued') n += 1;
        return n;
    }

    get errored(): MirrorCell[] {
        return this.list().filter((c) => c.error !== null);
    }

    /** one line for a status bar: cells, running, errors. */
    summary(): string {
        const cells = this.order.length;
        const parts = [`${cells} ${cells === 1 ? 'cell' : 'cells'}`];
        const running = this.running;
        if (running > 0) parts.push(`${running} running`);
        const errors = this.errored.length;
        if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
        return parts.join(' · ');
    }
}
