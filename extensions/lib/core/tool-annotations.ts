// what a tool does, as the four hints pi passes to a permission extension.
//
// pi 0.99 takes MCP's tool annotations on a registered tool: `readOnlyHint`,
// `destructiveHint`, `idempotentHint`, `openWorldHint`. they are four booleans
// with an awkward reading (destructive and idempotent mean nothing when a tool
// is read-only, and a missing hint is read as the dangerous case), so nothing
// here writes them out by hand: a tool says what it does to what it touches and
// how far it reaches, and this turns that into the four.
//
// the hints are not verified. they exist so a gate can tell `remove` from
// `pi_search` without a list of tool names, which is the `tool_call` handler in
// pi's own docs.

import type { ToolAnnotations } from '@earendil-works/pi-coding-agent';

/** what the call does to what it touches. */
export type ToolEffect =
    /** answers a question and changes nothing. */
    | 'read'
    /** creates or appends; nothing that was there stops existing. */
    | 'add'
    /** overwrites or deletes what was there. */
    | 'replace'
    /** moves state to a named value, so the same call twice leaves the same state. */
    | 'set';

/** how far the call reaches. */
export type ToolReach =
    /** this machine, or one the session is already attached to. */
    | 'local'
    /** an open world: the network, a workspace, another person's screen. */
    | 'open';

const EFFECTS: Readonly<Record<ToolEffect, Omit<ToolAnnotations, 'openWorldHint'>>> = {
    read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    add: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    replace: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    set: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

/** the hints for a tool that does `effect` to something `reach` away. */
export function does(effect: ToolEffect, reach: ToolReach): ToolAnnotations {
    return { ...EFFECTS[effect], openWorldHint: reach === 'open' };
}
