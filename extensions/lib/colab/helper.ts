// The Python side of the tools, and reading its answer.
//
// The structured tools (cells, vars, edit, ...) are Python functions in
// assets/colab_helper.py, run in the notebook's scratchpad. The scratchpad
// keeps nothing between calls, so the helper is prepended to every call
// rather than installed once; it is a few kilobytes over loopback. The
// helper prints one JSON document between two markers, and whatever else the
// notebook printed while its cells reran stays around it as ordinary stdout.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Execution } from './client';

const OPEN = '<<colab:json>>';
const CLOSE = '<</colab:json>>';

let cached: string | null = null;

export function helperSource(): string {
    if (cached === null) {
        cached = readFileSync(join(import.meta.dirname, '..', '..', 'assets', 'colab_helper.py'), 'utf8');
    }
    return cached;
}

/** python source: the helper, then a call of one of its functions. */
export function helperCall(fn: string, args: Record<string, unknown>): string {
    const literal = JSON.stringify(args);
    // json.loads keeps the argument round-trip exact: no repr of a js object,
    // no true/True mismatch.
    const call = `_args = _json.loads(${JSON.stringify(literal)})\n`;
    const ASYNC = new Set(['colab_edit', 'colab_set_ui', 'colab_packages', 'colab_screenshot']);
    const invoke = ASYNC.has(fn) ? `await ${fn}(**_args)` : `${fn}(**_args)`;
    return `${helperSource()}\n${call}${invoke}\n`;
}

export interface HelperAnswer<T> {
    readonly data: T | null;
    /** stdout with the json document removed. */
    readonly stdout: string;
    readonly stderr: string;
    readonly ok: boolean;
    readonly ms: number;
}

export function readAnswer<T>(execution: Execution): HelperAnswer<T> {
    const start = execution.stdout.indexOf(OPEN);
    const end = start < 0 ? -1 : execution.stdout.indexOf(CLOSE, start);
    if (start < 0 || end < 0) {
        return { data: null, stdout: execution.stdout, stderr: execution.stderr, ok: execution.ok, ms: execution.ms };
    }
    const json = execution.stdout.slice(start + OPEN.length, end);
    const rest = `${execution.stdout.slice(0, start)}${execution.stdout.slice(end + CLOSE.length)}`.replace(/\n{2,}/g, '\n').trim();
    let data: T | null = null;
    try {
        data = JSON.parse(json) as T;
    } catch {
        return { data: null, stdout: execution.stdout, stderr: `${execution.stderr}\nunreadable helper answer`, ok: false, ms: execution.ms };
    }
    return { data, stdout: rest, stderr: execution.stderr, ok: execution.ok, ms: execution.ms };
}
