// /cwd [path], and the cwd tool: change the directory the agent operates in,
// mid-session.
//
// The command was the only way in, so the person could move the session and the
// agent could not. A checkout it made, a directory it found, a worktree it was
// told to work in: each left it prefixing every command with a cd that the next
// command did not inherit. The tool and the command are one behaviour here, and
// both answer with the same location block.
//
// pi captures cwd when the built-in tools are constructed and exposes no public
// setter for the session cwd, so changing process.cwd() alone does not retarget
// read/write/edit/bash/grep/find/ls. this rebuilds those tools against the new
// directory and re-registers them, which is what pi does internally for base-tool
// overrides. the tradeoff: re-registered tools use default rendering, since the
// public create*Tool factories do not carry the built-ins' custom renderers.
//
// the target is stored per session, so a resume returns to the directory the
// session was last pointed at instead of the one it was started in. `[cwd]
// remember = false` in rho.toml turns that off.

import { existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import {
    createBashTool,
    createEditTool,
    createFindTool,
    createGrepTool,
    createLsTool,
    createReadTool,
    createWriteTool,
    type AgentToolResult,
    type ExtensionAPI,
    type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { TSchema } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { PersistedState } from './lib/state-store';
import { config } from './lib/config';
import { currentEnvironment } from './environment';
import { collapseHome } from './lib/text';
import { announceWhere, gitThrough, registerLocationRenderer, whereNote } from './lib/where-note';
import type { Place } from './lib/where-note';

const TARGET_VERSION = 1;

interface TargetState {
    readonly version: typeof TARGET_VERSION;
    readonly path: string;
}

function parseTargetState(raw: unknown): TargetState | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (s.version !== TARGET_VERSION || typeof s.path !== 'string' || s.path === '') return null;
    return { version: TARGET_VERSION, path: s.path };
}

// structural view of the built-in tools returned by create*Tool. they carry
// execute/parameters but not the definition-level renderers, which is why the
// re-registered tools render with the default shell.
interface BuiltTool {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    prepareArguments?: (...args: unknown[]) => unknown;
    executionMode?: ToolDefinition['executionMode'];
    execute(...args: unknown[]): Promise<AgentToolResult<unknown>>;
}

function toDefinition(tool: BuiltTool): ToolDefinition {
    return {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        prepareArguments: tool.prepareArguments,
        executionMode: tool.executionMode,
        execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
    };
}

function buildDefinitions(cwd: string): ToolDefinition[] {
    return [
        toDefinition(createReadTool(cwd)),
        toDefinition(createWriteTool(cwd)),
        toDefinition(createEditTool(cwd)),
        toDefinition(createBashTool(cwd)),
        toDefinition(createGrepTool(cwd)),
        toDefinition(createFindTool(cwd)),
        toDefinition(createLsTool(cwd)),
    ];
}

function expandPath(input: string, base: string): string {
    let p = input.trim();
    if (p === '~' || p.startsWith('~/')) {
        p = join(homedir(), p.slice(1));
    }
    return isAbsolute(p) ? p : resolve(base, p);
}

function isDir(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

// primary column is the resolved full path (~-subbed); when the user's own
// spelling used `..`, the relative form rides along in the dim description column.
function completionItem(abs: string, written: string, showRelative: boolean): AutocompleteItem {
    const full = collapseHome(abs);
    return showRelative ? { value: full, label: full, description: `(${written})` } : { value: full, label: full };
}

let currentCwd = process.cwd();
let store: PersistedState<TargetState> | null = null;
/** Held so anything that moves the session can re-register the tools. */
let host: ExtensionAPI | null = null;

// no status line here: the footer already prints the cwd on its first line,
// and it reads process.cwd(), so it stays accurate after a /cwd retarget.
const retarget = (cwd: string) => {
    if (host === null) return;
    for (const definition of buildDefinitions(cwd)) {
        host.registerTool(definition);
    }
};

/**
 * Move this machine's session into a directory, as `/cwd` does.
 *
 * Exported because a checkout lands somewhere and the session is meant to be
 * standing in it: the project tool says the working directory moves, and doing
 * that anywhere but here would leave pi's tools pointed at the old one.
 */
export function moveHere(path: string): string {
    if (!existsSync(path) || !isDir(path)) throw new Error(`not a directory: ${path}`);
    process.chdir(path);
    currentCwd = process.cwd();
    retarget(currentCwd);
    store?.write({ version: TARGET_VERSION, path: currentCwd });
    return currentCwd;
}

/** Where the tools act, without moving them. */
function standing(): Place {
    const remote = currentEnvironment();
    if (remote === undefined || !remote.alive) return { host: null, cwd: currentCwd };
    return { host: remote.host, cwd: remote.cwd, git: gitThrough((command, timeoutMs) => remote.capture(command, timeoutMs)) };
}

/**
 * Move them, and say where they ended up.
 *
 * With an environment attached, the directory that matters is the one on that
 * machine: changing this one would move the laptop's cwd while every command
 * still ran somewhere else.
 */
async function moveTo(arg: string): Promise<Place> {
    const remote = currentEnvironment();
    if (remote !== undefined && remote.alive) {
        const moved = await remote.chdir(arg);
        return { host: remote.host, cwd: moved, git: gitThrough((command, timeoutMs) => remote.capture(command, timeoutMs)) };
    }
    return { host: null, cwd: moveHere(expandPath(arg, currentCwd)) };
}

/** The directory, and the machine when it is not this one. */
const placeName = (place: Place): string => (place.host === null ? place.cwd : `${place.cwd} on ${place.host}`);

export default function (pi: ExtensionAPI) {
    host = pi;
    registerLocationRenderer(pi);

    pi.on('session_start', async (_event, ctx) => {
        currentCwd = ctx.cwd;
        if (!config.cwd.remember) return;
        store = PersistedState.open(
            { name: 'cwd', scope: 'session', parse: parseTargetState },
            { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
        );
        const stored = store.read();
        // a directory that has since been moved or deleted is dropped rather
        // than reported: the session still works from where pi started it.
        if (!stored || stored.path === currentCwd || !isDir(stored.path)) return;
        process.chdir(stored.path);
        currentCwd = process.cwd();
        retarget(currentCwd);
        ctx.ui.notify(`cwd -> ${currentCwd}`, 'info');
    });

    pi.registerTool({
        name: 'cwd',
        label: 'Directory',
        description:
            'Move the directory the tools act in, for the rest of the session: read, write, edit, bash, grep, find and ls all follow it. Acts on this machine, or on the attached one. With no path, reports where the tools are acting and changes nothing.',
        promptSnippet: 'Change the working directory the tools act in',
        promptGuidelines: [
            'Use cwd to move into a directory that several later commands act in, rather than prefixing each one with cd, which the next command does not inherit.',
        ],
        parameters: Type.Object({
            path: Type.Optional(
                Type.String({
                    description:
                        'Absolute, ~-relative, or relative to the current directory. Omit to report where the tools act.',
                }),
            ),
        }),
        async execute(_id: string, params: { path?: string }) {
            const asked = params.path?.trim() ?? '';
            try {
                if (asked === '') {
                    const here = standing();
                    return { content: [{ type: 'text' as const, text: `the tools act in ${placeName(here)}` }], details: undefined };
                }
                const moved = await moveTo(asked);
                // The same block the person's /cwd sends, as the answer rather
                // than as a message after it: the caller is the agent, and one
                // account of where it stands is enough.
                const note = await whereNote('cwd', moved);
                return { content: [{ type: 'text' as const, text: note.content }], details: undefined };
            } catch (error) {
                return {
                    content: [{ type: 'text' as const, text: (error as Error).message }],
                    isError: true,
                    details: undefined,
                };
            }
        },
    });

    pi.registerCommand('cwd', {
        description: 'change the working directory the agent operates in',
        getArgumentCompletions: (prefix) => {
            const raw = prefix;
            const usedDotDot = raw.split('/').includes('..');
            const endsWithSlash = raw.endsWith('/');
            const lastSlash = raw.lastIndexOf('/');
            // dirPart is the directory the user is typing inside; partial is the
            // in-progress final segment used to filter that directory's entries.
            const dirPart = endsWithSlash ? raw : lastSlash >= 0 ? raw.slice(0, lastSlash + 1) : '';
            const partial = endsWithSlash ? '' : lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
            const baseAbs = expandPath(dirPart === '' ? '.' : dirPart, currentCwd);
            if (!isDir(baseAbs)) {
                return null;
            }

            const items: AutocompleteItem[] = [];
            // if what the user actually wrote is itself a valid dir, it leads the
            // list, so pressing enter keeps their path instead of a child of it.
            const typedAbs = raw.trim() === '' ? '' : expandPath(raw, currentCwd);
            if (typedAbs !== '' && isDir(typedAbs)) {
                items.push(completionItem(typedAbs, raw, usedDotDot));
            }

            try {
                const children = readdirSync(baseAbs, { withFileTypes: true })
                    .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(partial.toLowerCase()))
                    .map((e) => ({ abs: join(baseAbs, e.name), written: dirPart + e.name }))
                    .filter((c) => c.abs !== typedAbs)
                    .sort((a, b) => a.written.localeCompare(b.written))
                    .map((c) => completionItem(c.abs, c.written, usedDotDot));
                items.push(...children);
            } catch {
                // baseAbs unreadable; fall through with whatever we have.
            }
            return items.length > 0 ? items : null;
        },
        handler: async (args, ctx) => {
            const arg = args.trim();
            if (arg === '') {
                ctx.ui.notify(`cwd: ${placeName(standing())}`, 'info');
                return;
            }
            let moved: Place;
            try {
                moved = await moveTo(arg);
            } catch (error) {
                const remote = currentEnvironment();
                const where = remote !== undefined && remote.alive ? ` (on ${remote.host})` : '';
                ctx.ui.notify(`${(error as Error).message}${where}`, 'error');
                return;
            }
            ctx.ui.notify(`cwd -> ${placeName(moved)}`, 'info');
            // The agent is told as well as the person: a directory it cannot
            // see it moved into is a directory it reasons about wrongly for
            // the rest of the session.
            await announceWhere(pi, 'cwd', moved);
        },
    });
}
