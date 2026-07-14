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
import { isAbsolute, join, resolve } from 'node:path';
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
    type ExtensionContext,
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

export default function (pi: ExtensionAPI) {
    let currentCwd = process.cwd();

    const showStatus = (ctx: ExtensionContext) => {
        const home = homedir();
        const shown = currentCwd.startsWith(home) ? `~${currentCwd.slice(home.length)}` : currentCwd;
        ctx.ui.setStatus('cwd', ctx.ui.theme.fg('dim', `cwd: ${shown}`));
    };

    const retarget = (cwd: string) => {
        for (const definition of buildDefinitions(cwd)) {
            pi.registerTool(definition);
        }
    };

    pi.on('session_start', async (_event, ctx) => {
        currentCwd = ctx.cwd;
        showStatus(ctx);
    });

    pi.registerCommand('cwd', {
        description: 'change the working directory the agent operates in',
        getArgumentCompletions: (prefix) => {
            const expanded = expandPath(prefix || '.', currentCwd);
            const dir = prefix.endsWith('/') || prefix === '' ? expanded : join(expanded, '..');
            if (!isDir(dir)) {
                return null;
            }
            try {
                return readdirSync(dir, { withFileTypes: true })
                    .filter((e) => e.isDirectory())
                    .map((e) => ({ value: e.name, label: `${e.name}/` }));
            } catch {
                return null;
            }
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
            showStatus(ctx);
            ctx.ui.notify(`cwd -> ${currentCwd}`, 'info');
        },
    });
}
