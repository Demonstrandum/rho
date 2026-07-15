// /cwd [path]: change the directory the agent operates in, mid-session.
//
// pi captures cwd when the built-in tools are constructed and exposes no public
// setter for the session cwd, so changing process.cwd() alone does not retarget
// read/write/edit/bash/grep/find/ls. this rebuilds those tools against the new
// directory and re-registers them, which is what pi does internally for base-tool
// overrides. the tradeoff: re-registered tools use default rendering, since the
// public create*Tool factories do not carry the built-ins' custom renderers.

import { existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
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

// collapse an absolute path back to ~ notation for display and insertion.
function collapseHome(abs: string): string {
    const home = homedir();
    if (abs === home) return '~';
    if (abs.startsWith(home + sep)) return `~${abs.slice(home.length)}`;
    return abs;
}

// primary column is the resolved full path (~-subbed); when the user's own
// spelling used `..`, the relative form rides along in the dim description column.
function completionItem(abs: string, written: string, showRelative: boolean): AutocompleteItem {
    const full = collapseHome(abs);
    return showRelative ? { value: full, label: full, description: `(${written})` } : { value: full, label: full };
}

export default function (pi: ExtensionAPI) {
    let currentCwd = process.cwd();

    // no status line here: the footer already prints the cwd on its first line,
    // and it reads process.cwd(), so it stays accurate after a /cwd retarget.
    const retarget = (cwd: string) => {
        for (const definition of buildDefinitions(cwd)) {
            pi.registerTool(definition);
        }
    };

    pi.on('session_start', async (_event, ctx) => {
        currentCwd = ctx.cwd;
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
            if (!arg) {
                ctx.ui.notify(`cwd: ${currentCwd}`, 'info');
                return;
            }
            const target = expandPath(arg, currentCwd);
            if (!existsSync(target) || !isDir(target)) {
                ctx.ui.notify(`not a directory: ${target}`, 'error');
                return;
            }
            process.chdir(target);
            currentCwd = process.cwd();
            retarget(currentCwd);
            ctx.ui.notify(`cwd -> ${currentCwd}`, 'info');
        },
    });
}
