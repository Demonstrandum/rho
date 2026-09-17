// /prompt: read what was actually sent to the provider, and write it to disk.
//
// nothing here reads ctx.getSystemPrompt(). that reports the string pi built,
// which is not what the model read: the provider serializer places it, splits
// it into cacheable blocks, or turns it into a message, and a
// before_provider_request handler may rewrite it after pi has handed it over.
// the payload carries the finished text along with every message and every tool
// schema, and that hook is the only place it exists, so each payload is kept in
// a bounded log (lib/prompt-log.ts) as it goes out, newest last. a session that
// has run no turn has sent no prompt, and the command says so rather than
// showing what pi holds.
//
// the viewer is two levels. the outline (lib/prompt-outline.ts) lists the
// payload as a tree, one row per property and per array element; enter opens
// the selected subtree in a pager (lib/pager.ts) with its strings printed as
// text rather than as JSON escapes, and `r` switches that pager to raw JSON.
// escape goes back up a level. SelectList takes its items at construction, so
// the outline is reopened after each pager rather than mutated, the way the
// stash picker does it.
//
// the dump writes the payload as JSON, which is the point of the dump: a file
// that round-trips is worth more than a readable one, and the viewer covers
// reading. the system prompt dumps as text, since that is what it is.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { Container, matchesKey, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Pager } from './lib/pager';
import { type CapturedRequest, RequestLog } from './lib/prompt-log';
import { type OutlineNode, outline, pretty, raw, systemText, weight } from './lib/prompt-outline';
import { collapseHome, truncate } from './lib/text';
import { publishedRelay } from './lib/remote/ui-relay';

type ViewKind = 'payload' | 'system' | 'json';

const VIEWS: Record<ViewKind, string> = {
    payload: 'browse the last provider payload as a tree',
    system: 'the system text of the last payload, as the provider read it',
    json: 'the last provider payload as raw JSON',
};

const SUBCOMMANDS = ['view', 'list', 'dump', 'clear'] as const;

// a payload holds the whole conversation, so the log is capped rather than
// grown. this many covers a turn and the retries around it.
const KEEP = 8;

/** what closed the outline: a node to open, or the reason there is none. */
type OutlineResult = { kind: 'open'; index: number } | { kind: 'close' };

function stamp(at: number): string {
    return new Date(at).toISOString().replace(/[:.]/g, '-');
}

function modelRef(ctx: ExtensionContext): string | null {
    const model = ctx.model;
    return model === undefined ? null : `${model.provider}/${model.id}`;
}

function requestTitle(request: CapturedRequest): string {
    const when = new Date(request.at).toISOString().slice(11, 19);
    return `request ${request.ordinal}  ${when}  ${request.model ?? 'no model'}`;
}

export default function (pi: ExtensionAPI) {
    const log = new RequestLog(KEEP);

    pi.on('before_provider_request', (event, ctx) => {
        log.record(event.payload, modelRef(ctx));
    });

    // ------------------------------------------------------------- writing

    // where a dump lands when the command is given no path: the session scratch
    // directory when there is one, since that is the directory that gets cleaned
    // up, else the working directory.
    function dumpDir(ctx: ExtensionContext): string {
        return process.env.RHO_SCRATCH ?? ctx.cwd;
    }

    function write(ctx: ExtensionContext, file: string, text: string): string {
        const path = isAbsolute(file) ? file : join(dumpDir(ctx), file);
        mkdirSync(resolve(path, '..'), { recursive: true });
        writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
        return path;
    }

    function dumpRequest(ctx: ExtensionContext, request: CapturedRequest, target?: string): string {
        const name = target ?? `prompt-${request.ordinal}-${stamp(request.at)}.json`;
        return write(ctx, name, JSON.stringify(request.payload, null, 2));
    }

    // ------------------------------------------------------------- viewing

    function pagerContent(node: OutlineNode, asJson: boolean) {
        return {
            title: `${node.path === '' ? 'payload' : node.path}  ${node.detail}`,
            lines: asJson ? raw(node.value) : pretty(node.value),
        };
    }

    /** a pager over fixed text. returns when the reader closes it. */
    function showPager(
        ctx: ExtensionContext,
        title: string,
        lines: readonly string[],
        toggleable: boolean,
        onToggle?: (asJson: boolean) => readonly string[],
    ): Promise<void> {
        let asJson = false;
        return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
            const hints = ['up/down scroll', 'pgup/pgdn page', 'home/end ends'];
            if (toggleable) hints.push('r raw json');
            hints.push('esc back');
            const pager = new Pager({ title, lines }, theme, () => tui.terminal.rows, hints);
            return {
                render: (width) => pager.render(width),
                invalidate: () => pager.invalidate(),
                handleInput: (data) => {
                    if (matchesKey(data, 'escape') || matchesKey(data, 'q')) {
                        done();
                        return;
                    }
                    if (toggleable && onToggle !== undefined && matchesKey(data, 'r')) {
                        asJson = !asJson;
                        pager.setContent({ title, lines: onToggle(asJson) });
                        tui.requestRender();
                        return;
                    }
                    if (pager.handleInput(data)) tui.requestRender();
                },
            };
        });
    }

    function outlineItem(node: OutlineNode, index: number): SelectItem {
        const indent = '  '.repeat(node.depth);
        return {
            value: String(index),
            label: `${indent}${truncate(node.label, 44)}`,
            description: `${node.kind}  ${node.detail}`,
        };
    }

    function header(theme: Theme, title: string): Text {
        return new Text(theme.fg('accent', theme.bold(title)), 1, 0);
    }

    /** one showing of the outline; it is reopened after a pager closes. */
    function showOutline(
        ctx: ExtensionContext,
        title: string,
        nodes: readonly OutlineNode[],
        cursor: number,
    ): Promise<OutlineResult> {
        return ctx.ui.custom<OutlineResult>((tui, theme, _keybindings, done) => {
            const container = new Container();
            container.addChild(header(theme, title));
            const rows = Math.max(6, Math.min(nodes.length, tui.terminal.rows - 10));
            const list = new SelectList(nodes.map(outlineItem), rows, getSelectListTheme());
            list.setSelectedIndex(cursor);
            list.onSelect = (item) => done({ kind: 'open', index: Number(item.value) });
            list.onCancel = () => done({ kind: 'close' });
            container.addChild(list);
            container.addChild(new Text(theme.fg('dim', 'up/down move, enter open, esc close'), 1, 0));
            return {
                render: (width) => container.render(width),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                    list.handleInput(data);
                    tui.requestRender();
                },
            };
        });
    }

    async function browse(ctx: ExtensionContext, request: CapturedRequest): Promise<void> {
        const nodes = outline(request.payload);
        if (nodes.length === 0) {
            await showPager(ctx, requestTitle(request), raw(request.payload), false);
            return;
        }
        let cursor = 0;
        for (;;) {
            const result = await showOutline(ctx, requestTitle(request), nodes, cursor);
            if (result.kind === 'close') return;
            cursor = result.index;
            const node = nodes[cursor];
            const formatted = pagerContent(node, false);
            await showPager(ctx, formatted.title, formatted.lines, true, (asJson) => pagerContent(node, asJson).lines);
        }
    }

    /** pick one of the captured requests, then browse it. */
    async function showList(ctx: ExtensionContext): Promise<void> {
        const requests = [...log.list()].reverse();
        const chosen = await ctx.ui.custom<number | null>((tui, theme, _keybindings, done) => {
            const container = new Container();
            container.addChild(header(theme, `provider requests (${requests.length})`));
            const items = requests.map((request) => ({
                value: String(request.ordinal),
                label: requestTitle(request),
                description: `${weight(request.payload)} chars`,
            }));
            const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
            list.onSelect = (item) => done(Number(item.value));
            list.onCancel = () => done(null);
            container.addChild(list);
            container.addChild(new Text(theme.fg('dim', 'up/down move, enter open, esc close'), 1, 0));
            return {
                render: (width) => container.render(width),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                    list.handleInput(data);
                    tui.requestRender();
                },
            };
        });
        if (chosen === null) return;
        const request = log.byOrdinal(chosen);
        if (request !== undefined) await browse(ctx, request);
    }

    // ------------------------------------------------------------ dispatch

    const NOTHING_YET = 'nothing sent yet; run a turn and the request is here';

    /**
     * Whether this process is drawing a session that runs elsewhere.
     *
     * A viewer sends nothing to a provider: the far side does, so the payload
     * log here stays empty however many turns have been answered on screen.
     * Saying "nothing sent yet" to someone watching a session mid-turn is a
     * false statement about the session, so the two cases are separated.
     */
    const viewing = (): boolean => publishedRelay() !== null;

    const ELSEWHERE =
        'the payloads are on the machine running this session; this terminal sends nothing to the provider. '
        + '/prompt view system shows the prompt it reported. for the payloads, take "prompt" out of '
        + '[remote] commands-here, which sends /prompt to the session, where /prompt dump writes them there.';

    function nothingCaptured(ctx: ExtensionContext): boolean {
        if (log.size > 0) return false;
        ctx.ui.notify(viewing() ? ELSEWHERE : NOTHING_YET, 'warning');
        return true;
    }

    // the system prompt as the provider received it, taken out of the last
    // payload rather than from ctx.getSystemPrompt(). the two differ: pi's
    // string is the prompt it built, and the payload is that prompt after the
    // provider serializer has placed it and after any before_provider_request
    // handler has rewritten it, which is what the model actually read.
    //
    // nothing is captured before the first turn, so there is no prompt to show
    // then rather than an empty one.
    function systemPrompt(ctx: ExtensionContext): string | null {
        const latest = log.latest();
        if (latest === undefined) {
            // A viewer has the far side's prompt as pi built it, carried with
            // the rest of the session state. It is not the payload text, and
            // the difference is said rather than glossed over.
            if (viewing()) {
                const reported = ctx.getSystemPrompt();
                if (reported !== '') {
                    ctx.ui.notify('the prompt the session reported, not the payload text; the payloads are on that machine', 'info');
                    return reported;
                }
            }
            ctx.ui.notify(viewing() ? ELSEWHERE : `no system prompt sent yet; ${NOTHING_YET}`, 'warning');
            return null;
        }
        const text = systemText(latest.payload);
        if (text === null) {
            ctx.ui.notify('the last payload carries no system field; browse it with /prompt view', 'warning');
            return null;
        }
        return text;
    }

    async function view(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
        const what = rest[0] ?? 'payload';
        if (what === 'system') {
            const prompt = systemPrompt(ctx);
            if (prompt === null) return;
            await showPager(ctx, `system prompt  ${requestTitle(log.latest()!)}`, prompt.split('\n'), false);
            return;
        }
        const ordinal = Number(what);
        if (Number.isInteger(ordinal) && ordinal > 0) {
            const request = log.byOrdinal(ordinal);
            if (request === undefined) {
                ctx.ui.notify(`no request ${ordinal} in the log`, 'warning');
                return;
            }
            await browse(ctx, request);
            return;
        }
        if (nothingCaptured(ctx)) return;
        const latest = log.latest()!;
        if (what === 'json') {
            await showPager(ctx, `${requestTitle(latest)}  json`, raw(latest.payload), false);
            return;
        }
        await browse(ctx, latest);
    }

    function dump(ctx: ExtensionCommandContext, rest: string[]): void {
        const what = rest[0] ?? '';
        if (what === 'system') {
            const prompt = systemPrompt(ctx);
            if (prompt === null) return;
            const path = write(ctx, rest[1] ?? `system-prompt-${stamp(Date.now())}.md`, prompt);
            ctx.ui.notify(`wrote ${collapseHome(path)}`, 'info');
            return;
        }
        if (nothingCaptured(ctx)) return;
        if (what === 'all') {
            const paths = log.list().map((request) => dumpRequest(ctx, request));
            ctx.ui.notify(`wrote ${paths.length} payloads to ${collapseHome(dumpDir(ctx))}`, 'info');
            return;
        }
        const ordinal = Number(what);
        const request = Number.isInteger(ordinal) && ordinal > 0 ? log.byOrdinal(ordinal) : log.latest();
        if (request === undefined) {
            ctx.ui.notify(`no request ${what} in the log`, 'warning');
            return;
        }
        const target = Number.isInteger(ordinal) && ordinal > 0 ? rest[1] : rest[0];
        ctx.ui.notify(`wrote ${collapseHome(dumpRequest(ctx, request, target))}`, 'info');
    }

    pi.registerCommand('prompt', {
        description: 'browse or dump the prompts sent to the provider',
        getArgumentCompletions: (prefix) => {
            const words = prefix.split(/\s+/);
            if (words.length <= 1) {
                return SUBCOMMANDS
                    .filter((name) => name.startsWith(words[0] ?? ''))
                    .map((name) => ({ value: name, label: name }));
            }
            if (words[0] === 'view') {
                return Object.entries(VIEWS)
                    .filter(([name]) => name !== 'payload' && name.startsWith(words[1] ?? ''))
                    .map(([name, description]) => ({ value: `view ${name}`, label: name, description }));
            }
            if (words[0] === 'dump') {
                return ['system', 'all']
                    .filter((name) => name.startsWith(words[1] ?? ''))
                    .map((name) => ({ value: `dump ${name}`, label: name }));
            }
            return null;
        },
        handler: async (args, ctx) => {
            const words = args.trim().split(/\s+/).filter((word) => word !== '');
            const [head, ...rest] = words;
            if (head === 'dump') {
                dump(ctx, rest);
                return;
            }
            if (ctx.mode !== 'tui') {
                ctx.ui.notify('/prompt view needs the interactive UI; use /prompt dump', 'warning');
                return;
            }
            if (head === 'clear') {
                ctx.ui.notify(`dropped ${log.clear()} captured requests`, 'info');
                return;
            }
            if (head === 'list') {
                if (nothingCaptured(ctx)) return;
                await showList(ctx);
                return;
            }
            if (head === undefined || head === 'view') {
                await view(ctx, rest);
                return;
            }
            await view(ctx, words);
        },
    });
}
