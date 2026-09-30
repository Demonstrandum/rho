// /config and the `config` tool: set rho.toml values for this session only,
// and save them to a file when they are worth keeping.
//
// an override is laid over the file each time lib/core/config.ts is
// evaluated, and every extension reads the config when it loads, so a change
// takes effect at a reload. /config reloads by itself after a change. the tool
// cannot: a reload needs the command context, which a tool call does not get,
// so the agent's changes wait for the next /reload, and the person is told so.
//
// the overrides live in process memory (see the store in lib/core/config.ts)
// and survive /reload. they are dropped when the session is replaced by /new,
// /resume or /fork, since they belong to the session that set them, and they
// are not written into the session file, so resuming it later starts from the
// file again.
//
//   /config                          the overrides, and whether they are applied
//   /config get <section[.key]>      a field, or a whole section
//   /config set <section.key> <v>    set for this session; v is a TOML value,
//                                    and a bare word is taken as a string
//   /config unset <section.key|all>  drop one override, or all of them
//   /config load <file>              every value in a TOML file, as overrides
//   /config save [file] [--changes]  write to a file (default: rho.toml).
//                                    --changes writes only the overrides,
//                                    merged into what the file holds

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
    defineTool,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { parse } from 'smol-toml';
import {
    allFields,
    clearOverride,
    clearOverrides,
    configPath,
    fieldState,
    loadOverrides,
    overrideStates,
    pathText,
    saveSession,
    setOverride,
    type FieldState,
    type SaveMode,
} from './lib/core/config';
import { collapseHome } from './lib/core/text';
import { does } from './lib/core/tool-annotations';

type Result = { ok: true; text: string; changed: boolean } | { ok: false; text: string };

const show = (value: unknown): string => JSON.stringify(value);

function describeState(state: FieldState): string {
    const lines = [`${pathText(state.info.path)} = ${show(state.loaded)}   (${state.info.type})`];
    if (state.override !== undefined) {
        lines.push(`  session override: ${show(state.override)}${state.pending ? ', applied at the next reload' : ''}`);
    }
    lines.push(`  default: ${show(state.info.default)}`);
    for (const doc of state.info.doc) lines.push(`  # ${doc}`);
    return lines.join('\n');
}

function listOverrides(): string {
    const states = overrideStates();
    const head = `config file: ${collapseHome(configPath)}`;
    if (states.length === 0) return `${head}\nno session overrides`;
    const rows = states.map(
        (s) => `  ${pathText(s.info.path)} = ${show(s.override)}${s.pending ? '   (applied at the next reload)' : ''}`,
    );
    return `${head}\nsession overrides:\n${rows.join('\n')}`;
}

function get(target: string): Result {
    if (!target.includes('.')) {
        const fields = allFields().filter((f) => f.path.section === target);
        if (fields.length === 0) return { ok: false, text: `unknown section "${target}"` };
        const text = fields.map((f) => describeState(fieldState(pathText(f.path)) as FieldState)).join('\n\n');
        return { ok: true, text, changed: false };
    }
    const state = fieldState(target);
    return 'error' in state ? { ok: false, text: state.error } : { ok: true, text: describeState(state), changed: false };
}

function set(values: Readonly<Record<string, unknown>>): Result {
    const done: string[] = [];
    const errors: string[] = [];
    for (const [target, value] of Object.entries(values)) {
        const state = setOverride(target, value);
        if ('error' in state) errors.push(state.error);
        else done.push(`${pathText(state.info.path)} = ${show(value)}`);
    }
    if (done.length === 0) return { ok: false, text: errors.join('\n') };
    const text = [`set for this session:`, ...done.map((d) => `  ${d}`), ...errors.map((e) => `not set: ${e}`)];
    return { ok: true, text: text.join('\n'), changed: true };
}

function unset(target: string): Result {
    if (target === 'all') {
        const count = clearOverrides();
        return { ok: true, text: `dropped ${count} session override${count === 1 ? '' : 's'}`, changed: count > 0 };
    }
    const result = clearOverride(target);
    if (typeof result !== 'boolean') return { ok: false, text: result.error };
    return result
        ? { ok: true, text: `dropped the session override on ${target}`, changed: true }
        : { ok: true, text: `${target} has no session override`, changed: false };
}

function load(file: string): Result {
    let result: ReturnType<typeof loadOverrides>;
    try {
        result = loadOverrides(file);
    } catch (e) {
        return { ok: false, text: `could not read ${collapseHome(file)}: ${(e as Error).message}` };
    }
    const lines = [`set ${result.set.length} value${result.set.length === 1 ? '' : 's'} from ${collapseHome(file)} for this session`];
    for (const p of result.problems) lines.push(`  ${p.at}: ${p.message}`);
    const text = lines.join('\n');
    return result.set.length > 0 ? { ok: true, text, changed: true } : { ok: false, text };
}

function save(file: string, mode: SaveMode): Result {
    try {
        saveSession(file, mode);
    } catch (e) {
        return { ok: false, text: `could not write ${collapseHome(file)}: ${(e as Error).message}` };
    }
    // written into the file the session reads, an override only repeats it.
    const intoLive = resolve(file) === resolve(configPath);
    if (intoLive) clearOverrides();
    const what = mode === 'all' ? 'the whole config' : 'the session overrides';
    return { ok: true, text: `wrote ${what} to ${collapseHome(file)}`, changed: false };
}

function expand(file: string, cwd: string): string {
    const home = file === '~' || file.startsWith('~/') ? homedir() + file.slice(1) : file;
    return isAbsolute(home) ? home : resolve(cwd, home);
}

/** a value as typed after /config set: TOML if it parses, else the words as a string. */
function typedValue(text: string): unknown {
    try {
        return (parse(`v = ${text}`) as { v: unknown }).v;
    } catch {
        return text;
    }
}

const USAGE = [
    'usage:',
    '  /config',
    '  /config get <section[.key]>',
    '  /config set <section.key> <value>',
    '  /config unset <section.key|all>',
    '  /config load <file>',
    '  /config save [file] [--changes]',
].join('\n');

function runCommand(args: string, cwd: string): Result {
    const trimmed = args.trim();
    const [verb = '', ...rest] = trimmed.split(/\s+/);
    const tail = trimmed.slice(verb.length).trim();
    switch (verb) {
        case '':
        case 'list':
            return { ok: true, text: listOverrides(), changed: false };
        case 'get':
            return rest[0] === undefined ? { ok: false, text: USAGE } : get(rest[0]);
        case 'set': {
            const match = tail.match(/^([^\s=]+)\s*(?:=\s*|\s+)(.+)$/s);
            if (match === null) return { ok: false, text: USAGE };
            return set({ [match[1]!]: typedValue(match[2]!.trim()) });
        }
        case 'unset':
            return rest[0] === undefined ? { ok: false, text: USAGE } : unset(rest[0]);
        case 'load':
            return tail === '' ? { ok: false, text: USAGE } : load(expand(tail, cwd));
        case 'save': {
            const changes = rest.includes('--changes');
            const file = rest.filter((word) => word !== '--changes').join(' ');
            return save(file === '' ? configPath : expand(file, cwd), changes ? 'changes' : 'all');
        }
        default:
            return { ok: false, text: USAGE };
    }
}

const VERBS = ['get', 'set', 'unset', 'load', 'save'] as const;

function completions(prefix: string): { value: string; label: string; description?: string }[] | null {
    const words = prefix.split(/\s+/);
    if (words.length <= 1) {
        const items = VERBS.filter((v) => v.startsWith(words[0] ?? '')).map((v) => ({ value: `${v} `, label: v }));
        return items.length === 0 ? null : items;
    }
    const verb = words[0];
    if (words.length !== 2 || !(verb === 'get' || verb === 'set' || verb === 'unset')) return null;
    const typed = words[1]!;
    const paths = verb === 'unset' ? [...overrideStates().map((s) => pathText(s.info.path)), 'all'] : allFields().map((f) => pathText(f.path));
    const items = paths
        .filter((p) => p.startsWith(typed))
        .slice(0, 50)
        .map((p) => ({ value: `${verb} ${p}${verb === 'set' ? ' ' : ''}`, label: p }));
    return items.length === 0 ? null : items;
}

export default function (pi: ExtensionAPI) {
    pi.on('session_shutdown', (event) => {
        if (event.reason === 'new' || event.reason === 'resume' || event.reason === 'fork') clearOverrides();
    });

    pi.registerCommand('config', {
        description: 'set rho.toml values for this session, and save them: /config set <section.key> <value>',
        getArgumentCompletions: completions,
        async handler(args: string, ctx: ExtensionCommandContext) {
            const result = runCommand(args, ctx.cwd);
            const reload = result.ok && result.changed;
            ctx.ui.notify(reload ? `${result.text}\nreloading` : result.text, result.ok ? 'info' : 'error');
            // nothing from this runtime is used after the reload.
            if (reload) await ctx.reload();
        },
    });

    pi.registerTool(
        defineTool({
            name: 'config',
            annotations: does('set', 'local'),
            label: 'Config',
            description:
                "Read and change rho's settings (rho.toml) for this session only, and save them to a file. " +
                'Fields are named section.key in TOML spelling, e.g. "starfield.tools". ' +
                'Changes take effect when the person next runs /reload; say so when you make one. ' +
                'Use get with a section name to see every field in it, with its type, default and documentation.',
            parameters: Type.Object({
                action: Type.Union(
                    [
                        Type.Literal('list'),
                        Type.Literal('get'),
                        Type.Literal('set'),
                        Type.Literal('unset'),
                        Type.Literal('load'),
                        Type.Literal('save'),
                    ],
                    {
                        description:
                            'list: the session overrides. get: a field or section. set: override fields for this session. ' +
                            'unset: drop an override ("all" for every one). load: override from a TOML file. save: write to a file.',
                    },
                ),
                field: Type.Optional(Type.String({ description: 'section.key, or a section for get, or "all" for unset.' })),
                values: Type.Optional(
                    Type.Record(Type.String(), Type.Unknown(), {
                        description: 'for set: section.key -> value, typed as in TOML (true, 3, "text", ["a", "b"]).',
                    }),
                ),
                file: Type.Optional(Type.String({ description: 'for load and save. save defaults to the rho.toml the session reads.' })),
                mode: Type.Optional(
                    Type.Union([Type.Literal('all'), Type.Literal('changes')], {
                        description: 'for save. all: every field. changes: only the overrides, merged into the file. default: all.',
                    }),
                ),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
                const need = (what: string): Result => ({ ok: false, text: `${params.action} needs ${what}` });
                let result: Result;
                switch (params.action) {
                    case 'list':
                        result = { ok: true, text: listOverrides(), changed: false };
                        break;
                    case 'get':
                        result = params.field === undefined ? need('field') : get(params.field);
                        break;
                    case 'set':
                        result = params.values === undefined ? need('values') : set(params.values);
                        break;
                    case 'unset':
                        result = params.field === undefined ? need('field') : unset(params.field);
                        break;
                    case 'load':
                        result = params.file === undefined ? need('file') : load(expand(params.file, ctx.cwd));
                        break;
                    case 'save':
                        result = save(params.file === undefined ? configPath : expand(params.file, ctx.cwd), params.mode ?? 'all');
                        break;
                }
                if (!result.ok) throw new Error(result.text);
                let text = result.text;
                if (result.changed) {
                    text += '\nthis takes effect at the next /reload, which the person runs.';
                    ctx.ui.notify(`${result.text}\n/reload to apply`, 'info');
                }
                return { content: [{ type: 'text', text }], details: {} };
            },
        }),
    );
}
