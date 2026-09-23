// /colab, and the marimo_* tools: the agent and the person in one notebook.
//
// marimo (marimo.io) is a reactive Python notebook stored as a plain .py file
// and run by a kernel that knows the dataflow graph between cells. The kernel
// is reached over HTTP, and it exposes a scratchpad in which arbitrary code
// runs against the live namespace, with a private module (`marimo._code_mode`)
// through which that code can add, edit, delete, move and run cells, set UI
// values and install packages. That is the whole surface this extension uses;
// the tools are shaped views onto it, so the model spends its calls on the
// notebook rather than on learning the module.
//
//   marimo_open      find or start a server, attach to the notebook's session
//                    (creating and running it when there is none), show the cells
//   marimo_cells     the cell table, or named cells in full: code, output, errors
//   marimo_run       run code in the scratchpad against the live namespace
//   marimo_edit      create / edit / delete / move / run cells, in one batch
//   marimo_vars      what the notebook's variables hold: type, shape, columns, value
//   marimo_ui        set a UI element's value, as a person would in the browser
//   marimo_check     `marimo check`: lint (and fix) notebook files
//   marimo_export    a notebook as html, markdown, ipynb or a flat script
//   marimo_convert   an .ipynb or .md into a marimo notebook
//
// And for the person: /colab <notebook.py> opens it for both, in the browser
// and for the tools; /colab status, /colab open, /colab app (the notebook as a
// read-only app, through `marimo run`), /colab mcp (the endpoint other agents
// can attach to), /colab stop.
//
// Why not the marimo-pair skill as it ships: it needs a browser tab open to
// have a session to talk to, passes every question through a shell script and
// jq, and leaves the model to learn the `cm` module from `help()`. Here the
// session is created headless (lib/colab/session.ts), the answers come back
// structured, and the browser is where the person joins in: `/colab` opens
// it on the same kernel, so what either party runs, the other sees.
//
// Servers this session starts are stopped with it unless `[colab] keep`.
// Servers found running (any `marimo edit --no-token`, from the registry) are
// used and left alone.

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { config } from './lib/config';
import { helperCall, readAnswer } from './lib/colab/helper';
import { cellDetail, cellTable, clip, lintText, runLength, type CellRecord, type CellsAnswer } from './lib/colab/format';
import { chooseRunner, isNotebook, parseLint, run as runMarimo, wantsSandbox, type Runner } from './lib/colab/marimo-cli';
import { discover, start, type Started } from './lib/colab/server';
import { NotebookSession } from './lib/colab/session';
import { healthy, type ServerAddress } from './lib/colab/client';
import { collapseHome, quantity, truncate } from './lib/text';
import { currentEnvironment } from './environment';
import { listSessions } from './lib/colab/client';
import { PersistedState } from './lib/state-store';

interface Attached {
    readonly session: NotebookSession;
    readonly address: ServerAddress;
    /** the child, when this session started the server. */
    readonly started: Started | null;
    readonly runner: Runner | null;
    /** when a tool last reported on this notebook, for "meanwhile" notes. */
    seenAt: number;
}

/**
 * what changed in the browser since the model last looked. the person and the
 * agent share the kernel, so an edit the person made between two tool calls
 * is something the model has to be told, or it reasons from a stale table.
 */
function meanwhile(attached: Attached): string {
    const since = attached.session.mirror.activitySince(attached.seenAt);
    attached.seenAt = Date.now();
    const theirs = since.filter((a) => a.source === 'frontend' || a.source === 'file-watch');
    if (theirs.length === 0) return '';
    const WORDS: Record<string, string> = {
        'set-code': 'code changed',
        'create-cell': 'created',
        'delete-cell': 'deleted',
        'move-cell': 'moved',
        'reorder-cells': 'reordered',
        'set-name': 'renamed',
        'set-config': 'config changed',
    };
    const byCell = new Map<string, Set<string>>();
    for (const a of theirs) {
        const key = a.cellId ?? '(notebook)';
        const kinds = byCell.get(key) ?? new Set<string>();
        kinds.add(WORDS[a.kind] ?? a.kind);
        byCell.set(key, kinds);
    }
    const parts = [...byCell.entries()].map(([id, kinds]) => `${id} ${[...kinds].join(', ')}`);
    const where = theirs.some((a) => a.source === 'file-watch') ? 'in the browser or on disk' : 'in the browser';
    return `\nmeanwhile, edited ${where}: ${parts.join('; ')}. read a changed cell again before editing it.`;
}

interface ToolText {
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
    details: Record<string, unknown>;
}

const EMPTY_NOTEBOOK = `import marimo

app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    return (mo,)


if __name__ == "__main__":
    app.run()
`;

const notebooks = new Map<string, Attached>();
const started = new Map<string, Started>();
let current: string | null = null;
let uiHost: ExtensionContext['ui'] | null = null;

// which notebooks this session had open, so a resume finds them again when
// their servers are still up (a person's, or ours under [colab] keep).
const OPEN_VERSION = 1;
interface OpenState {
    readonly version: typeof OPEN_VERSION;
    readonly paths: readonly string[];
    readonly current: string | null;
}
const parseOpenState = (raw: unknown): OpenState | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (r.version !== OPEN_VERSION || !Array.isArray(r.paths)) return null;
    return { version: OPEN_VERSION, paths: r.paths.filter((p): p is string => typeof p === 'string'), current: typeof r.current === 'string' ? r.current : null };
};
let openStore: PersistedState<OpenState> | null = null;
const remember = (): void => {
    openStore?.write({ version: OPEN_VERSION, paths: [...notebooks.keys()], current });
};

const text = (body: string, details: Record<string, unknown> = {}): ToolText => ({ content: [{ type: 'text', text: body }], details });

const fail = (message: string): never => {
    throw new Error(message);
};

const openBrowser = (url: string): void => {
    const [command, args] =
        process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
};

const expand = (input: string, cwd: string): string => {
    const p = input.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
    return isAbsolute(p) ? p : resolve(cwd, p);
};

/** whether the runner's python has the mcp extra, when that is cheap to see. */
function mcpAvailable(runner: Runner): boolean {
    if (runner.kind !== 'venv') return true; // unknown: try, and fall back on failure
    const lib = join(dirname(dirname(runner.argv[0]!)), 'lib');
    try {
        return readdirSync(lib).some((py) => existsSync(join(lib, py, 'site-packages', 'mcp')));
    } catch {
        return true;
    }
}

/**
 * optional arguments as the model sends them when it means "none": json null,
 * or the word null as a string. both read as absent, so a call that spells
 * an omitted notebook as "null" does not fail on a notebook called null.
 */
function dropNulls<T>(args: unknown): T {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return args as T;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && /^(null|none|undefined)$/i.test(value.trim()) && key !== 'code' && key !== 'value') continue;
        out[key] = value;
    }
    return out as T;
}

/** notebooks in a directory, top level only: what `marimo_open` lists. */
function notebooksIn(dir: string, limit = 40): string[] {
    try {
        return readdirSync(dir)
            .filter((name) => name.endsWith('.py'))
            .map((name) => join(dir, name))
            .filter((path) => isNotebook(path))
            .slice(0, limit);
    } catch {
        return [];
    }
}

let lastStatus = '';

/** the footer line, redrawn only when it would read differently. */
function refreshStatus(): void {
    if (uiHost === null || !config.colab.status) return;
    let text = '';
    const attached = current === null ? undefined : notebooks.get(current);
    if (current !== null && attached !== undefined) {
        const live = attached.session.watching ? '' : ' (feed lost)';
        text = `⬢ ${basename(current)} · ${attached.session.mirror.summary()}${live}`;
    }
    if (text === lastStatus) return;
    lastStatus = text;
    uiHost.setStatus('colab', text);
}

/** the attached notebook a tool call means: named, or the current one. */
function attachedFor(notebook: string | undefined, cwd: string): Attached {
    if (notebook !== undefined && notebook.trim() !== '') {
        const path = expand(notebook, cwd);
        const hit = notebooks.get(path);
        if (hit !== undefined) return hit;
        const byName = [...notebooks.entries()].filter(([p]) => basename(p) === notebook.trim());
        if (byName.length === 1) return byName[0]![1];
        return fail(`${notebook} is not open. open it with marimo_open first${notebooks.size > 0 ? `; open: ${[...notebooks.keys()].map((p) => collapseHome(p)).join(', ')}` : ''}`);
    }
    if (current === null) return fail('no notebook is open. call marimo_open with a path first.');
    return notebooks.get(current) ?? fail('the current notebook is gone; open one with marimo_open');
}

/**
 * attach to a notebook, starting a server when no running one has it.
 * the whole of `marimo_open` and `/colab <path>`.
 */
async function open(pathInput: string, cwd: string, options: { run?: boolean; sandbox?: boolean } = {}): Promise<{ attached: Attached; note: string }> {
    // the tools here reach a server over loopback and read files on this
    // machine; an attached environment is another machine, and a notebook
    // opened there would be a different one from what the model reads.
    const remote = currentEnvironment();
    if (remote !== undefined && remote.alive) {
        fail(`an environment is attached (${remote.host}); the marimo tools act on this machine only. detach it, or give a url to a marimo server reachable from here (ssh -L forwards one).`);
    }
    if (/^https?:\/\//.test(pathInput.trim())) return openUrl(pathInput.trim(), options);
    const path = expand(pathInput, cwd);
    const known = notebooks.get(path);
    if (known !== undefined) {
        current = path;
        refreshStatus();
        return { attached: known, note: 'already open' };
    }
    let fresh = false;
    if (!existsSync(path) || statSync(path).size === 0) {
        // a notebook that does not exist yet. marimo would create an empty
        // file and a kernel with one empty cell; writing the smallest valid
        // notebook first gives the model a file it can read back and the
        // kernel a cell that imports marimo, which every notebook wants.
        if (!path.endsWith('.py')) fail(`${collapseHome(path)} does not exist, and a new notebook needs a .py name`);
        if (!existsSync(dirname(path))) fail(`${collapseHome(dirname(path))} does not exist`);
        writeFileSync(path, EMPTY_NOTEBOOK, 'utf8');
        fresh = true;
    } else if (statSync(path).isDirectory()) {
        const found = notebooksIn(path);
        fail(found.length > 0 ? `${collapseHome(path)} is a directory. notebooks in it:\n${found.map((p) => `  ${collapseHome(p)}`).join('\n')}` : `${collapseHome(path)} is a directory with no marimo notebooks at its top level`);
    } else if (!isNotebook(path)) {
        fail(`${collapseHome(path)} is not a marimo notebook (no marimo.App). for an .ipynb use marimo_convert first.`);
    }

    // a server that already has this file open, or any server that answers,
    // is used before one is started: the person may have opened it.
    let note = '';
    let address: ServerAddress | null = null;
    let child: Started | null = null;
    let runner: Runner | null = null;
    for (const server of await discover()) {
        if (server.url === null) continue;
        try {
            const sessions = await listSessions({ url: server.url });
            if (sessions.some((s) => s.path === path)) {
                address = { url: server.url };
                note = `joined the session already open on ${server.url} (marimo ${server.version}, pid ${server.pid})`;
                break;
            }
        } catch {
            // a tokenised server refuses /api/sessions; not ours to use
        }
    }
    let shared = false;
    if (address === null) {
        runner = chooseRunner(cwd, config.colab.runner);
        const sandbox = options.sandbox ?? wantsSandbox(path, config.colab.sandbox);
        // one server serves every notebook under a directory, so a project's
        // second notebook joins the first's server rather than starting
        // another. a sandboxed notebook gets its own: the environment
        // --sandbox builds is the file's, not the directory's.
        const reusable = sandbox ? undefined : [...started.values()].find((s) => !s.sandbox && (path.startsWith(`${s.target}/`) || dirname(path) === s.target));
        if (reusable !== undefined) {
            address = { url: reusable.url };
            shared = true;
            note = `on the server already running for ${collapseHome(reusable.target)} (${reusable.url})`;
        } else {
            const target = sandbox ? path : cwd;
            let mcp = config.colab.mcp && mcpAvailable(runner);
            try {
                child = await start({ runner, cwd, target, port: config.colab.port, sandbox, mcp });
            } catch (error) {
                // the --mcp flag is fatal without the marimo[mcp] extra. the
                // notebook matters more than the endpoint: start without it.
                if (!mcp || !/MCP dependencies/i.test((error as Error).message)) throw new Error(`could not start marimo: ${(error as Error).message}`);
                mcp = false;
                child = await start({ runner, cwd, target, port: config.colab.port, sandbox, mcp });
            }
            started.set(child.url, child);
            address = { url: child.url };
            note += `started ${child.command} (pid ${child.pid})${mcp ? `; MCP endpoint at ${child.url}/mcp/server` : ''}`;
        }
    }
    if (fresh) note = `created ${collapseHome(path)}; ${note}`;

    let session: NotebookSession;
    try {
        session = await NotebookSession.attach(address, path, options.run ?? config.colab.runOnOpen, config.colab.waitSeconds * 1000);
    } catch (error) {
        // a server started for a session that never came up is a stray
        if (child !== null) {
            const tail = child.tail();
            await child.stop();
            started.delete(child.url);
            throw new Error(`the server started but the session for ${collapseHome(path)} did not: ${(error as Error).message}${tail === '' ? '' : `\nserver said:\n${tail}`}`);
        }
        throw new Error(`could not open a session for ${collapseHome(path)} on ${address.url}: ${(error as Error).message}`);
    }
    if (shared) child = [...started.values()].find((s) => s.url === address!.url) ?? null;
    const attached: Attached = { session, address, started: child, runner, seenAt: Date.now() };
    notebooks.set(path, attached);
    current = path;
    session.onChange(refreshStatus);
    refreshStatus();
    remember();
    if (session.created) note += `; created the kernel session${options.run ?? config.colab.runOnOpen ? ' and ran every cell' : ''}`;
    return { attached, note };
}

/**
 * attach by url: a server someone started, with a token when they gave one
 * (`http://host:port/?access_token=...&file=...`). the session it holds is
 * the notebook; with several, `file` picks.
 */
async function openUrl(raw: string, options: { run?: boolean }): Promise<{ attached: Attached; note: string }> {
    const url = new URL(raw);
    const token = url.searchParams.get('access_token') ?? undefined;
    const file = url.searchParams.get('file');
    const address: ServerAddress = { url: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`, token };
    if (!(await healthy(address.url))) fail(`nothing marimo answers at ${address.url}`);
    const sessions = await listSessions(address);
    let path: string | null = null;
    if (file !== null) {
        path = sessions.find((s) => s.path === file || s.filename === file || basename(s.path ?? '') === file)?.path ?? file;
    } else if (sessions.length === 1) {
        path = sessions[0]!.path;
    } else if (sessions.length === 0) {
        fail(`${address.url} has no notebook open; open one in the browser there, or give ?file=<path>`);
    } else {
        fail(`${address.url} has several notebooks open; add ?file= one of:\n${sessions.map((s) => `  ${s.path ?? s.filename ?? s.id}`).join('\n')}`);
    }
    if (path === null) return fail('no notebook path');
    const found: string = path;
    const known = notebooks.get(found);
    if (known !== undefined) {
        current = found;
        refreshStatus();
        return { attached: known, note: 'already open' };
    }
    const session = await NotebookSession.attach(address, found, options.run ?? false);
    const attached: Attached = { session, address, started: null, runner: null, seenAt: Date.now() };
    notebooks.set(found, attached);
    current = found;
    session.onChange(refreshStatus);
    refreshStatus();
    remember();
    return { attached, note: `${session.created ? 'created a session' : 'joined the session'} for ${found} on ${address.url}` };
}

async function closeNotebook(path: string): Promise<string> {
    const attached = notebooks.get(path);
    if (attached === undefined) return `${collapseHome(path)} is not open`;
    attached.session.close();
    notebooks.delete(path);
    let note = `detached from ${collapseHome(path)}`;
    // the server goes when the last notebook on it goes, and only if we started it
    if (attached.started !== null && !config.colab.keep) {
        const stillUsed = [...notebooks.values()].some((a) => a.address.url === attached.address.url);
        if (!stillUsed) {
            await attached.started.stop();
            started.delete(attached.started.url);
            note += `; stopped the server on ${attached.address.url}`;
        }
    }
    if (current === path) current = notebooks.size > 0 ? [...notebooks.keys()].at(-1)! : null;
    refreshStatus();
    remember();
    return note;
}

/** run a helper function in the notebook and hand back its json. */
async function ask<T>(attached: Attached, fn: string, args: Record<string, unknown>, signal?: AbortSignal, detachAfterMs: number | null = null) {
    const execution = await attached.session.executeOrDetach(helperCall(fn, args), signal, undefined, 20_000, detachAfterMs);
    if (execution.pending === true) return { data: null, stdout: '', stderr: '', ok: true, ms: execution.ms, pending: true as const };
    const answer = readAnswer<T>(execution);
    if (answer.data === null) {
        if (/truncated a very large console output/.test(answer.stdout)) {
            fail('the notebook printed more than marimo passes on, and the answer was cut with it. run the code with less output (print a summary, not the data).');
        }
        // never the raw stdout at length: it may be anything the notebook printed
        const why = [answer.stderr.trim(), answer.stdout.trim()].filter((s) => s !== '').join('\n').replace(/[A-Za-z0-9+/=]{200,}/g, '[…binary…]');
        fail(`the notebook did not answer${why === '' ? '' : `:\n${clip(why, 1200)}`}`);
    }
    return { ...answer, pending: false as const };
}

/**
 * an image the kernel wrote to a file, read and removed. the file, not
 * stdout, because a PNG in base64 is a megabyte marimo truncates and the
 * model would otherwise be shown.
 */
function takeImage(file: string, mimeType: string): ToolText['content'][number] | null {
    try {
        const data = readFileSync(file).toString('base64');
        rmSync(file, { force: true });
        return { type: 'image', data, mimeType: mimeType.startsWith('image/') ? mimeType : 'image/png' };
    } catch {
        return null;
    }
}

const outputImages = (cells: readonly CellRecord[]): ToolText['content'] => {
    const images: ToolText['content'] = [];
    for (const cell of cells) {
        const out = cell.output;
        if (out?.image_file !== undefined) {
            const image = takeImage(out.image_file, out.mimetype);
            if (image !== null) images.push(image);
        }
    }
    return images;
};

const header = (attached: Attached, count: number, errored: number): string => {
    const parts = [collapseHome(attached.session.path), quantity(count, 'cell')];
    if (errored > 0) parts.push(`${errored} with errors`);
    parts.push(attached.address.url);
    return parts.join(' · ');
};

/**
 * the table as the live feed knows it, for when the kernel cannot answer:
 * a cell that is running holds the one thread, and the helper would queue
 * behind it. codes come from kernel-ready and the transactions since; defs
 * and refs from the variables message; outputs are not known here.
 */
function mirrorTable(attached: Attached): CellsAnswer {
    const mirror = attached.session.mirror;
    const defs = new Map<string, string[]>();
    const refs = new Map<string, string[]>();
    for (const v of mirror.vars()) {
        for (const id of v.declaredBy) defs.set(id, [...(defs.get(id) ?? []), v.name]);
        for (const id of v.usedBy) refs.set(id, [...(refs.get(id) ?? []), v.name]);
    }
    const cells: CellRecord[] = mirror.list().map((c) => ({
        id: c.id,
        name: c.name === '_' ? null : c.name,
        status: c.status,
        lines: c.code === '' ? 0 : c.code.split('\n').length,
        defs: (defs.get(c.id) ?? []).sort(),
        refs: (refs.get(c.id) ?? []).sort(),
        errors: c.error === null ? [] : [{ kind: 'runtime', msg: c.error }],
        preview: c.code.split('\n', 1)[0] ?? '',
        has_output: c.hasOutput,
        runMs: c.runningSince !== null ? Date.now() - c.runningSince : c.runMs,
    }));
    return { count: cells.length, cells, errored: cells.filter((c) => c.errors.length > 0).map((c) => c.id) };
}

/** helper records with what only the feed knows: how long each cell ran. */
function withTimings(attached: Attached, cells: readonly CellRecord[]): CellRecord[] {
    return cells.map((c) => {
        const seen = attached.session.mirror.cell(c.id);
        if (seen === undefined) return c;
        // a cell still running is timed from when it began
        if (seen.runningSince !== null) return { ...c, runMs: Date.now() - seen.runningSince };
        return seen.runMs === null ? c : { ...c, runMs: seen.runMs };
    });
}

/**
 * playwright and its chromium, into the kernel's interpreter with `uv pip`,
 * which leaves the project's manifest alone. says what it did, or what to run.
 */
async function installPlaywright(attached: Attached, signal?: AbortSignal): Promise<string> {
    const python = (await ask<{ python: string }>(attached, 'colab_python', {}, signal)).data?.python;
    if (python === undefined) return 'screenshots need playwright; the kernel did not say which python it runs';
    const uv = ['/opt/homebrew/bin/uv', '/usr/local/bin/uv', join(process.env.HOME ?? '', '.local', 'bin', 'uv'), ...(process.env.PATH ?? '').split(':').map((d) => join(d, 'uv'))].find((p) => existsSync(p));
    const manual = `to enable screenshots, run: ${uv ?? 'uv'} pip install --python ${python} playwright && ${python} -m playwright install chromium`;
    if (uv === undefined) return `screenshots need playwright in the kernel environment. ${manual}`;
    const sh = (cmd: string, args: string[]) =>
        new Promise<{ code: number | null; out: string }>((done) => {
            const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            child.stdout.on('data', (c: Buffer) => (out += c.toString()));
            child.stderr.on('data', (c: Buffer) => (out += c.toString()));
            const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
            signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
            child.on('close', (code) => {
                clearTimeout(timer);
                done({ code, out });
            });
        });
    const pip = await sh(uv, ['pip', 'install', '--python', python, 'playwright']);
    if (pip.code !== 0) return `screenshots need playwright; installing it failed:\n${clip(pip.out.trim(), 800)}\n${manual}`;
    const browser = await sh(python, ['-m', 'playwright', 'install', 'chromium']);
    if (browser.code !== 0) return `playwright installed, but its chromium did not:\n${clip(browser.out.trim(), 800)}\n${manual}`;
    return `installed playwright and chromium into ${python} (with uv pip, so the project manifest is untouched)`;
}

/** the cell table, as `marimo_open` and `marimo_cells` both show it. */
async function overview(attached: Attached, signal?: AbortSignal): Promise<{ body: string; data: CellsAnswer }> {
    let data: CellsAnswer;
    const busy = attached.session.busyWith;
    if (busy.length > 0) {
        // do not queue a question behind a running cell: answer from the feed
        data = mirrorTable(attached);
    } else {
        const answer = await ask<CellsAnswer>(attached, 'colab_cells', { ids: null, limit: config.colab.outputChars }, signal);
        data = { ...answer.data!, cells: withTimings(attached, answer.data!.cells) };
    }
    const stale = data.stale ?? [];
    // a joined session may never have run: a person opened the file and
    // left, or the browser has run-on-startup off. say so, and how to run.
    const staleNote = stale.length > 0 ? `\n${quantity(stale.length, 'cell')} stale (not run since last changed): marimo_edit with {op: "run", id: "stale"} runs them` : '';
    const running = data.cells.filter((c) => c.status === 'running' || c.status === 'queued').map((c) => c.id);
    const runningNote = running.length > 0 ? `\nstill running: ${running.join(', ')}. outputs arrive when they finish; marimo_cells shows the state later` : '';
    const body = `${header(attached, data.count, data.errored.length)}\n${cellTable(data)}${staleNote}${runningNote}${meanwhile(attached)}`;
    return { body, data };
}

/** named cells in full, outputs included. */
async function readCells(attached: Attached, ids: readonly string[], signal?: AbortSignal): Promise<CellRecord[]> {
    const answer = await ask<CellsAnswer>(attached, 'colab_cells', { ids, limit: config.colab.outputChars }, signal);
    const data = answer.data!;
    if (data.error !== undefined) fail(`${data.error}. cells: ${(data as unknown as { cells: string[] }).cells.join(', ')}`);
    return withTimings(attached, data.cells);
}

export default function (pi: ExtensionAPI) {
    /**
     * Loaded rather than always present, as the environment and remote tools
     * are: nine definitions cost prompt on every request of every session,
     * and most sessions never see a notebook. skills/marimo/SKILL.md names
     * the tools in a line the model can act on, and the definitions arrive
     * when something asks: the skill being read, /colab being used, a
     * notebook being named, or a file that builds marimo.App being read.
     */
    const OWN = ['marimo_open', 'marimo_cells', 'marimo_run', 'marimo_edit', 'marimo_vars', 'marimo_ui', 'marimo_check', 'marimo_export', 'marimo_convert'];
    /** Set by whatever asked for the tools, read by the hide below. */
    let asked = false;
    const load = (): void => {
        asked = true;
        const active = pi.getActiveTools();
        const missing = OWN.filter((name) => !active.includes(name));
        if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
    };
    /** Take the tools out of the loadout, until something asks for them. */
    const hide = (): void => {
        if (asked || notebooks.size > 0) return;
        pi.setActiveTools(pi.getActiveTools().filter((name) => !OWN.includes(name)));
    };

    pi.on('input', async (event) => {
        if (/\bmarimo\b|\bnotebook\b|\bcolab\b|\.ipynb\b|skill:marimo/i.test(event.text)) load();
        return { action: 'continue' as const };
    });

    pi.on('tool_call', async (event) => {
        // the skill being read, or a notebook file, is a request too
        if (event.toolName === 'read') {
            const path = String((event.input as { path?: unknown }).path ?? '');
            if (/skills\/marimo\/SKILL\.md$/.test(path)) load();
            else if (path.endsWith('.py') || path.endsWith('.ipynb')) {
                try {
                    const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
                    if (path.endsWith('.ipynb') || isNotebook(abs)) load();
                } catch {
                    // unreadable: not a notebook we can act on
                }
            }
        }
    });

    pi.on('session_start', async (_event, ctx) => {
        uiHost = ctx.ui;
        // before the first request goes out, unlike a hide on the first tool
        // call, which lets one request carry every definition. the input
        // handler runs before the request too, so a message that asks for
        // the tools still has them.
        hide();
        openStore = PersistedState.open({ name: 'colab', scope: 'session', parse: parseOpenState }, { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
        const stored = openStore.read();
        refreshStatus();
        if (stored === null || stored.paths.length === 0) return;
        // servers outlive a session only when kept or when a person owns
        // them; whichever still has one of our notebooks open is rejoined,
        // and the rest are forgotten without a word.
        const servers = (await discover()).filter((s) => s.url !== null);
        for (const path of stored.paths) {
            for (const server of servers) {
                try {
                    const sessions = await listSessions({ url: server.url! });
                    if (!sessions.some((s) => s.path === path)) continue;
                    const session = await NotebookSession.attach({ url: server.url! }, path, false);
                    notebooks.set(path, { session, address: { url: server.url! }, started: null, runner: null, seenAt: Date.now() });
                    session.onChange(refreshStatus);
                    break;
                } catch {
                    // not this one
                }
            }
        }
        current = stored.current !== null && notebooks.has(stored.current) ? stored.current : ([...notebooks.keys()].at(-1) ?? null);
        remember();
        refreshStatus();
        if (notebooks.size > 0) {
            load();
            ctx.ui.notify(`colab: rejoined ${[...notebooks.keys()].map((p) => basename(p)).join(', ')}`, 'info');
        }
    });

    pi.on('session_shutdown', async () => {
        for (const attached of notebooks.values()) attached.session.close();
        notebooks.clear();
        current = null;
        if (config.colab.keep) return;
        await Promise.all([...started.values()].map((s) => s.stop()));
        started.clear();
    });

    // the model is told which notebooks are attached, and at which url a
    // person can look, on every turn. stable text: the cell states change
    // every call and live in tool results, not here.
    pi.on('before_agent_start', (event) => {
        if (notebooks.size === 0) return;
        const lines = [...notebooks.entries()].map(([path, a]) => `- ${collapseHome(path)} on ${a.address.url}${path === current ? ' (current)' : ''}`);
        const options = event.systemPromptOptions;
        if (options === undefined) return;
        options.sections ??= {};
        options.sections.marimo = `Notebooks open in a live marimo kernel (use the marimo_* tools on them, not file edits; the kernel writes the file):\n${lines.join('\n')}`;
    });

    // ------------------------------------------------------------ tools --

    pi.registerTool({
        name: 'marimo_open',
        label: 'marimo open',
        prepareArguments: dropNulls,
        description:
            'Open a marimo notebook (.py) in a live kernel: joins the session a running marimo server already has for it, or starts a headless server and creates one, running every cell. Returns the cell table (ids, status, first line, defined and referenced names, errors). Later marimo_* calls default to the notebook opened last. With no path, lists the notebooks in the working directory, the servers running, and what is open. A path that does not exist yet is created as an empty notebook.',
        promptSnippet: 'Open a marimo notebook in a live kernel and see its cells',
        promptGuidelines: [
            'A file that imports marimo and builds marimo.App is a marimo notebook: work on it through marimo_open and the other marimo_* tools, whose edits go through the running kernel and are written to the file by marimo. Editing the .py directly while it is open is lost or overwritten.',
        ],
        parameters: Type.Object({
            path: Type.Optional(Type.String({ description: 'notebook file, relative to the working directory; or the url of a running marimo server (with ?access_token= when it has one, and ?file= when it has several notebooks open). omit to list.' })),
            run: Type.Optional(Type.Boolean({ description: 'run every cell when the session is created (default from [colab] run-on-open). a found session is left as is.' })),
            sandbox: Type.Optional(Type.Boolean({ description: 'force --sandbox on or off for a server this starts; default reads the file for PEP 723 metadata.' })),
            close: Type.Optional(Type.Boolean({ description: 'detach from the notebook instead, stopping the server if this session started it and nothing else uses it.' })),
        }),
        async execute(_id, params, signal, _update, ctx) {
            const cwd = ctx.cwd;
            if (params.close === true) {
                const path = params.path === undefined ? current : expand(params.path, cwd);
                if (path === null) return text('nothing is open');
                return text(await closeNotebook(path));
            }
            if (params.path === undefined || params.path.trim() === '') {
                const lines: string[] = [];
                const here = notebooksIn(cwd);
                lines.push(here.length === 0 ? `no marimo notebooks at the top level of ${collapseHome(cwd)}` : `notebooks in ${collapseHome(cwd)}:\n${here.map((p) => `  ${basename(p)}`).join('\n')}`);
                const servers = await discover();
                if (servers.length > 0) {
                    const described: string[] = [];
                    for (const s of servers) {
                        let open = '';
                        if (s.url !== null) {
                            try {
                                const sessions = await listSessions({ url: s.url });
                                open = sessions.length === 0 ? ', no notebook open' : `, open: ${sessions.map((x) => collapseHome(x.path ?? x.filename ?? x.id)).join(', ')}`;
                            } catch {
                                open = ', sessions not readable (token?)';
                            }
                        }
                        described.push(`  ${s.url ?? s.id} (marimo ${s.version}, pid ${s.pid}${s.url === null ? ', not answering' : ''}${open})`);
                    }
                    lines.push(`marimo servers running:\n${described.join('\n')}`);
                }
                if (notebooks.size > 0) lines.push(`open here:\n${[...notebooks.entries()].map(([p, a]) => `  ${collapseHome(p)} on ${a.address.url}${p === current ? ' (current)' : ''} · ${a.session.mirror.summary()}`).join('\n')}`);
                return text(lines.join('\n\n'), { listing: true });
            }
            const { attached, note } = await open(params.path, cwd, { run: params.run, sandbox: params.sandbox });
            const { body, data } = await overview(attached, signal);
            const browser = `a person can join at ${attached.session.browserUrl}`;
            return text(`${note}\n${browser}\n\n${body}`, { count: data.count, errored: data.errored.length, url: attached.address.url });
        },
        renderCall(args, theme) {
            const a = args as { path?: string; close?: boolean };
            const verb = a.close === true ? 'close' : a.path === undefined ? 'list' : 'open';
            return new Text(`${theme.fg('toolTitle', theme.bold('marimo'))} ${theme.fg('muted', verb)} ${theme.fg('dim', a.path ?? '')}`, 0, 0);
        },
        renderResult(result, { expanded }, theme) {
            const first = result.content.find((c) => c.type === 'text');
            const body = first !== undefined && first.type === 'text' ? first.text : '';
            const lines = body.split('\n');
            return new Text(expanded ? body : theme.fg('dim', truncate(lines[0] ?? '', 120)), 0, 0);
        },
    });

    pi.registerTool({
        name: 'marimo_cells',
        label: 'marimo cells',
        prepareArguments: dropNulls,
        description:
            'The open notebook, cell by cell. Without ids: one line per cell, in notebook order (id, status, first line, +extra lines, names defined and referenced, how long a slow cell ran), errors under the cells that have them. With ids (cell ids or cell names): each cell in full, with its code, its output as text (images attached), console output and errors. With screenshot: the named cells rendered as a person sees them, as PNGs, for outputs that have no text form (altair, plotly, tables, widgets); needs playwright and chromium in the kernel environment, and says so if they are missing.',
        promptSnippet: 'List the cells of the open marimo notebook, or read some in full',
        parameters: Type.Object({
            ids: Type.Optional(Type.Array(Type.String(), { description: 'cell ids or names to read in full. omit for the table.' })),
            notebook: Type.Optional(Type.String({ description: 'which open notebook, when more than one is. default: the current one.' })),
            screenshot: Type.Optional(Type.Boolean({ description: 'with ids: also render each cell output through a headless browser and attach the PNGs.' })),
        }),
        async execute(_id, params, signal, _update, ctx) {
            const attached = attachedFor(params.notebook, ctx.cwd);
            if (params.ids === undefined || params.ids.length === 0) {
                const { body, data } = await overview(attached, signal);
                return text(body, { count: data.count, errored: data.errored.length });
            }
            const cells = await readCells(attached, params.ids, signal);
            let body = cells.map(cellDetail).join('\n\n');
            const images = outputImages(cells);
            if (params.screenshot === true) {
                interface Shots {
                    shots: { id: string; image_file: string }[];
                    errors: { id: string; error: string }[];
                }
                const shoot = () => ask<Shots>(attached, 'colab_screenshot', { targets: params.ids, file: attached.session.path }, signal);
                let data = (await shoot()).data!;
                const missing = data.errors.some((e) => /Playwright is not installed|playwright install/i.test(e.error));
                if (missing) {
                    // into the kernel's environment, not the project: `uv add`
                    // is what marimo's own installer does in a uv project, and
                    // a screenshot is no reason to edit pyproject.toml
                    const note = await installPlaywright(attached, signal);
                    body += `\n\n${note}`;
                    if (/installed/.test(note)) data = (await shoot()).data!;
                }
                for (const shot of data.shots) {
                    const image = takeImage(shot.image_file, 'image/png');
                    if (image !== null) images.push(image);
                }
                if (data.shots.length > 0) body += `\n\n${quantity(data.shots.length, 'screenshot')} attached: ${data.shots.map((s) => s.id).join(', ')}`;
                if (data.errors.length > 0 && !(missing && data.shots.length > 0)) body += `\n\nscreenshots failed:\n${data.errors.map((e) => `  ${e.id}: ${e.error.split('\n')[0]}`).join('\n')}`;
            }
            body += meanwhile(attached);
            return { content: [{ type: 'text', text: body }, ...images], details: { ids: params.ids } };
        },
        renderCall(args, theme) {
            const a = args as { ids?: string[] };
            const what = a.ids === undefined || a.ids.length === 0 ? 'table' : a.ids.join(' ');
            return new Text(`${theme.fg('toolTitle', theme.bold('marimo cells'))} ${theme.fg('dim', what)}`, 0, 0);
        },
        renderResult(result, { expanded }, theme) {
            const first = result.content.find((c) => c.type === 'text');
            const body = first !== undefined && first.type === 'text' ? first.text : '';
            const d = result.details as { count?: number; errored?: number; ids?: string[] } | undefined;
            const line = d?.count !== undefined ? `${quantity(d.count, 'cell')}${(d.errored ?? 0) > 0 ? `, ${d.errored} with errors` : ''}` : `${quantity(d?.ids?.length ?? 0, 'cell')} read`;
            return new Text(expanded ? body : theme.fg('dim', line), 0, 0);
        },
    });

    pi.registerTool({
        name: 'marimo_run',
        label: 'marimo run',
        prepareArguments: dropNulls,
        description:
            "Run Python in the open notebook's scratchpad: the live namespace is visible by name (every variable a cell defines), top-level `await` works, and the value of the last expression is returned along with stdout and stderr. Assignments made here do not persist and do not create cells: use marimo_edit for that. Good for looking at data, trying a transformation before committing it to a cell, and calling functions the notebook defines. Packages are installed with marimo_edit's install op.",
        promptSnippet: 'Run Python against the live namespace of the open marimo notebook',
        promptGuidelines: [
            'To inspect or try something in an open marimo notebook, use marimo_run rather than a bash python call: the notebook variables are only alive in the kernel. To install a package into it, use marimo_edit with an install op, not pip or uv.',
        ],
        parameters: Type.Object({
            code: Type.String({ description: 'python source. the last expression is the result. may be empty with interrupt.' }),
            notebook: Type.Optional(Type.String({ description: 'which open notebook. default: the current one.' })),
            timeout: Type.Optional(Type.Integer({ description: 'seconds to wait before interrupting the kernel. default 600.' })),
            interrupt: Type.Optional(Type.Boolean({ description: 'stop whatever the kernel is running first. the kernel is one thread: code sent while a cell runs waits for it.' })),
        }),
        async execute(_id, params, signal, _update, ctx) {
            const attached = attachedFor(params.notebook, ctx.cwd);
            if (params.interrupt === true) {
                const was = attached.session.busyWith;
                await attached.session.interrupt();
                await attached.session.settle(10_000, signal);
                if (params.code.trim() === '') return text(was.length > 0 ? `interrupted ${was.join(', ')}` : 'nothing was running');
            }
            const before = attached.session.mirror.version;
            const execution = await attached.session.execute(params.code, signal, (params.timeout ?? 600) * 1000);
            const parts: string[] = [];
            const limit = config.colab.outputChars;
            if (execution.stdout.trim() !== '') parts.push(clip(execution.stdout.replace(/\n$/, ''), limit));
            if (execution.result.trim() !== '') parts.push(`=> ${clip(execution.result, limit)}`);
            if (execution.stderr.trim() !== '') parts.push(`stderr:\n${clip(execution.stderr.replace(/\n$/, ''), limit)}`);
            if (parts.length === 0) parts.push(execution.ok ? '(no output)' : '(failed with no output)');
            // cells the code caused to run (through cm) show in the feed; say
            // which ones now error so the model does not have to ask.
            if (attached.session.mirror.version !== before) {
                await new Promise((r) => setTimeout(r, 200));
                const errored = attached.session.mirror.errored;
                if (errored.length > 0) parts.push(`cells with errors now: ${errored.map((c) => `${c.id} (${truncate(c.error ?? '', 160)})`).join('; ')}`);
            }
            const body = `${parts.join('\n')}${meanwhile(attached)}`;
            if (!execution.ok) fail(body);
            return text(body, { ok: execution.ok, ms: Math.round(execution.ms) });
        },
        renderCall(args, theme) {
            const a = args as { code?: string };
            const first = (a.code ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
            const more = (a.code ?? '').split('\n').length - 1;
            return new Text(`${theme.fg('toolTitle', theme.bold('marimo run'))} ${theme.fg('dim', truncate(first, 100))}${more > 0 ? theme.fg('muted', ` +${more}`) : ''}`, 0, 0);
        },
        renderResult(result, { expanded }, theme) {
            const first = result.content.find((c) => c.type === 'text');
            const body = first !== undefined && first.type === 'text' ? first.text : '';
            const d = result.details as { ms?: number } | undefined;
            const lines = body.split('\n');
            const head = `${truncate(lines[0] ?? '', 110)}${lines.length > 1 ? ` … ${quantity(lines.length, 'line')}` : ''}${d?.ms !== undefined ? theme.fg('muted', ` ${d.ms}ms`) : ''}`;
            return new Text(expanded ? body : theme.fg('dim', head), 0, 0);
        },
    });

    const opSchema = Type.Object({
        op: StringEnum(['create', 'edit', 'delete', 'move', 'run', 'install', 'uninstall'] as const),
        id: Type.Optional(Type.String({ description: 'cell id or name (edit, delete, move, run); or a ref given to an earlier create in this batch. for run: "stale" runs every stale or errored cell, "all" every cell.' })),
        code: Type.Optional(Type.String({ description: 'cell body (create, edit). the contents, not an @app.cell wrapper. for edit: the whole new body.' })),
        after: Type.Optional(Type.String({ description: 'place after this cell id (create, move). default for create: the end.' })),
        before: Type.Optional(Type.String({ description: 'place before this cell id (create, move).' })),
        name: Type.Optional(Type.String({ description: 'a name for the cell (create), usable as an id later.' })),
        ref: Type.Optional(Type.String({ description: 'a label for a created cell, so later ops in the same batch can refer to it.' })),
        run: Type.Optional(Type.Boolean({ description: 'run the cell after create/edit. default true.' })),
        hide_code: Type.Optional(Type.Boolean({ description: 'collapse the code editor in the browser (create). default false.' })),
        packages: Type.Optional(Type.Array(Type.String(), { description: "package names (install, uninstall): installed with the notebook's own package manager before the cell ops apply. in a uv project that is `uv add`, which edits pyproject.toml and uv.lock; in a sandboxed notebook, the inline metadata. for a tool the notebook itself does not need (a renderer, a profiler), install with bash instead: `uv pip install --python <venv python> <pkg>` leaves the project untouched." })),
    });

    pi.registerTool({
        name: 'marimo_edit',
        label: 'marimo edit',
        prepareArguments: dropNulls,
        description:
            "Change the open notebook's cells through the kernel, in one validated batch: create, edit (replace the whole body), delete, move, run, install/uninstall packages. Cells created or edited run by default; their dependents rerun reactively. marimo rejects a batch that breaks its graph rules (a public name defined in two cells, a cycle, `import *`) and says why; nothing is applied then. Returns the touched cells with status, output and errors, plus any other cell now erroring. The kernel saves the file.",
        promptSnippet: 'Create, edit, delete, move or run cells in the open marimo notebook',
        promptGuidelines: [
            'Each public name in a marimo notebook is defined by exactly one cell. To change a value, edit the owning cell (marimo_cells shows defs) or use a new name; names starting with _ are private to their cell.',
        ],
        parameters: Type.Object({
            ops: Type.Array(opSchema, { description: 'applied in order, all or nothing.' }),
            notebook: Type.Optional(Type.String({ description: 'which open notebook. default: the current one.' })),
        }),
        async execute(_id, params, signal, _update, ctx) {
            const attached = attachedFor(params.notebook, ctx.cwd);
            if (params.ops.length === 0) fail('no ops given');
            for (const op of params.ops) {
                if ((op.op === 'create' || op.op === 'edit') && (op.code === undefined || op.code.trim() === '')) fail(`${op.op} needs code`);
                if (op.op === 'install' || op.op === 'uninstall') {
                    if (op.packages === undefined || op.packages.length === 0) fail(`${op.op} needs packages`);
                } else if (op.op !== 'create' && (op.id === undefined || op.id === '')) fail(`${op.op} needs an id`);
            }
            interface EditAnswer {
                applied: boolean;
                error?: string;
                traceback?: string;
                created?: Record<string, string>;
                touched?: CellRecord[];
                other_errors?: CellRecord[];
                count?: number;
            }
            // a cell the person changed since the model last looked is not
            // overwritten on the strength of the old body: the edit is refused
            // with the current code, and the model resends against that.
            const targets = new Set(params.ops.filter((op) => op.op === 'edit').map((op) => op.id ?? ''));
            const changed = attached.session.mirror
                .activitySince(attached.seenAt)
                .filter((a) => (a.source === 'frontend' || a.source === 'file-watch') && a.cellId !== null && targets.has(a.cellId) && a.kind === 'set-code');
            if (changed.length > 0) {
                const ids = [...new Set(changed.map((a) => a.cellId!))];
                const now = ids.map((id) => `${id}:\n${(attached.session.mirror.cell(id)?.code ?? '').split('\n').map((l) => `    ${l}`).join('\n')}`).join('\n');
                attached.seenAt = Date.now();
                fail(`not applied: ${ids.join(', ')} ${ids.length === 1 ? 'was' : 'were'} edited in the browser since you last looked. the code now:\n${now}\nresend the edit against this, keeping what the person changed.`);
            }
            const startedAt = Date.now();
            const answer = await ask<EditAnswer>(attached, 'colab_edit', { ops: params.ops, limit: config.colab.outputChars }, signal, config.colab.waitSeconds * 1000);
            if (answer.pending) {
                // the batch is in the kernel and a cell is taking its time;
                // the request stays open behind us so the cell is not cut
                await new Promise((r) => setTimeout(r, 300));
                const running = attached.session.busyWith.map((id) => {
                    const c = attached.session.mirror.cell(id);
                    return c?.runningSince !== null && c?.runningSince !== undefined ? `${id} (running for ${runLength(Date.now() - c.runningSince)})` : id;
                });
                return text(`the batch was applied and its cells are still running after ${config.colab.waitSeconds}s: ${running.length > 0 ? running.join(', ') : 'the kernel is busy'}. marimo_cells shows them when they finish; marimo_run with interrupt stops them.`, { touched: 0, errors: 0, pending: true });
            }
            const data = answer.data!;
            if (!data.applied) {
                fail(`nothing applied: ${data.error ?? 'unknown error'}${data.traceback !== undefined && !/Multiply|cycle|not allowed|Validation/i.test(data.error ?? '') ? `\n${clip(data.traceback, 2000)}` : ''}`);
            }
            // outputs are frozen at scratchpad start, so the cells that just
            // ran show none in the same call: read them again for what they
            // produced, once the kernel has settled.
            let touched = data.touched ?? [];
            if (touched.length > 0) {
                await attached.session.settle(config.colab.waitSeconds * 1000, signal);
                try {
                    touched = await readCells(attached, touched.map((c) => c.id), signal);
                } catch {
                    // deleted between the two calls, or the kernel is busy: the first answer stands
                }
            }
            const parts: string[] = [];
            const created = Object.entries(data.created ?? {});
            if (created.length > 0) parts.push(`created: ${created.map(([ref, id]) => (ref.startsWith('new') ? id : `${ref}=${id}`)).join(', ')}`);
            const took = Date.now() - startedAt;
            parts.push(`${quantity(data.count ?? 0, 'cell')} in the notebook now${took >= 2000 ? ` (applied and ran in ${runLength(took)})` : ''}`);
            if (touched.length > 0) parts.push(touched.map(cellDetail).join('\n\n'));
            const others = data.other_errors ?? [];
            if (others.length > 0) parts.push(`other cells with errors:\n${cellTable({ count: 0, cells: others, errored: [] })}`);
            const running = attached.session.busyWith;
            if (running.length > 0) parts.push(`still running after ${config.colab.waitSeconds}s: ${running.join(', ')}. marimo_cells shows them later; marimo_run with interrupt stops them.`);
            if (answer.stdout.trim() !== '') {
                const lines = answer.stdout.trim().split('\n');
                const shown = lines.length > 8 ? [`… ${lines.length - 8} lines`, ...lines.slice(-8)] : lines;
                parts.push(`stdout while applying:\n${clip(shown.join('\n'), 1500)}`);
            }
            return { content: [{ type: 'text', text: `${parts.join('\n\n')}${meanwhile(attached)}` }, ...outputImages(touched)], details: { touched: touched.length, errors: touched.filter((c) => c.errors.length > 0).length + others.length } };
        },
        renderCall(args, theme) {
            const a = args as { ops?: Array<{ op: string; id?: string; ref?: string }> };
            const ops = a.ops ?? [];
            const summary = ops.map((o) => `${o.op}${o.id !== undefined ? ` ${o.id}` : o.ref !== undefined ? ` ${o.ref}` : ''}`).join(', ');
            return new Text(`${theme.fg('toolTitle', theme.bold('marimo edit'))} ${theme.fg('dim', truncate(summary, 110))}`, 0, 0);
        },
        renderResult(result, { expanded }, theme) {
            const first = result.content.find((c) => c.type === 'text');
            const body = first !== undefined && first.type === 'text' ? first.text : '';
            const d = result.details as { touched?: number; errors?: number } | undefined;
            const line = d === undefined ? truncate(body.split('\n')[0] ?? '', 110) : `${quantity(d.touched ?? 0, 'cell')} touched${(d.errors ?? 0) > 0 ? theme.fg('error', `, ${quantity(d.errors ?? 0, 'error')}`) : ''}`;
            return new Text(expanded ? body : theme.fg('dim', line), 0, 0);
        },
    });

    pi.registerTool({
        name: 'marimo_vars',
        label: 'marimo vars',
        prepareArguments: dropNulls,
        description:
            "The open notebook's variables: type, and for each what is most telling (shape and columns with dtypes for a dataframe or array, length for a collection, the current value of a UI element, a clipped repr otherwise), and the cell that defines it. Without names: every public name. Cheaper than marimo_run when the question is what a variable is.",
        promptSnippet: 'Summarise the variables in the open marimo notebook',
        parameters: Type.Object({
            names: Type.Optional(Type.Array(Type.String(), { description: 'variables to describe. omit for all public names.' })),
            notebook: Type.Optional(Type.String({ description: 'which open notebook. default: the current one.' })),
            chars: Type.Optional(Type.Integer({ description: 'repr length per variable. default 300.' })),
        }),
        async execute(_id, params, signal, _update, ctx) {
            const attached = attachedFor(params.notebook, ctx.cwd);
            interface VarsAnswer {
                variables: Record<string, Record<string, unknown>>;
                missing: string[];
            }
            const answer = await ask<VarsAnswer>(attached, 'colab_vars', { names: params.names ?? null, limit: params.chars ?? 300 }, signal);
            const data = answer.data!;
            const lines: string[] = [];
            for (const [name, info] of Object.entries(data.variables)) {
                const bits: string[] = [String(info.type)];
                if (info.shape !== undefined) bits.push(`shape ${JSON.stringify(info.shape)}`);
                if (info.len !== undefined) bits.push(`len ${String(info.len)}`);
                if (info.cell !== undefined) bits.push(`cell ${String(info.cell)}`);
                lines.push(`${name}: ${bits.join(', ')}`);
                if (Array.isArray(info.columns)) {
                    const dtypes = (info.dtypes ?? {}) as Record<string, string>;
                    lines.push(`  columns: ${(info.columns as string[]).map((c) => (dtypes[c] !== undefined ? `${c} (${dtypes[c]})` : c)).join(', ')}`);
                }
                if (info.value !== undefined) lines.push(`  value: ${String(info.value)}`);
                else if (info.repr !== undefined) lines.push(`  ${String(info.repr).replace(/\n/g, '\n  ')}`);
                if (info.repr_error !== undefined) lines.push(`  (repr failed: ${String(info.repr_error)})`);
            }
            if (data.missing.length > 0) lines.push(`not defined: ${data.missing.join(', ')}`);
            if (lines.length === 0) lines.push('no public variables yet');
            return text(lines.join('\n'), { count: Object.keys(data.variables).length });
        },
        renderCall(args, theme) {
            const a = args as { names?: string[] };
            return new Text(`${theme.fg('toolTitle', theme.bold('marimo vars'))} ${theme.fg('dim', a.names?.join(' ') ?? 'all')}`, 0, 0);
        },
        renderResult(result, { expanded }, theme) {
            const first = result.content.find((c) => c.type === 'text');
            const body = first !== undefined && first.type === 'text' ? first.text : '';
            const d = result.details as { count?: number } | undefined;
            return new Text(expanded ? body : theme.fg('dim', quantity(d?.count ?? 0, 'variable')), 0, 0);
        },
    });

    pi.registerTool({
        name: 'marimo_ui',
        label: 'marimo ui',
        prepareArguments: dropNulls,
        description:
            'Set the value of a UI element in the open notebook (a mo.ui.slider, dropdown, text, switch, ...), as a person would in the browser: the cells that read it rerun. `element` is a Python expression naming it, usually the variable (`slider`, or `form.value["name"]` style attribute paths are not settable: name the element itself). Returns the value it holds afterwards and any cells now erroring.',
        promptSnippet: 'Set a UI element value in the open marimo notebook',
        parameters: Type.Object({
            element: Type.String({ description: 'python expression for the element, evaluated in the notebook namespace.' }),
            value: Type.Unknown({
                description:
                    'the new value in its natural form, not a string of json: a number for a slider or number input, the option (as shown) for a dropdown or radio, a list of options for a multiselect, a boolean for a switch or checkbox, a string for text.',
            }),
            notebook: Type.Optional(Type.String({ description: 'which open notebook. default: the current one.' })),
        }),
        async execute(_id, params, signal, _update, ctx) {
            const attached = attachedFor(params.notebook, ctx.cwd);
            interface UiAnswer {
                applied: boolean;
                error?: string;
                value?: string;
                unchanged?: boolean;
                errored?: string[];
            }
            const answer = await ask<UiAnswer>(attached, 'colab_set_ui', { expression: params.element, value: params.value }, signal);
            const data = answer.data!;
            if (!data.applied) fail(data.error ?? 'could not set the value');
            await attached.session.settle(120_000, signal);
            const errored = attached.session.mirror.errored;
            let body = `${params.element}.value is now ${data.value ?? '?'}${data.unchanged === true ? ' (unchanged: the element did not accept the value)' : ''}`;
            if (errored.length > 0) body += `\ncells with errors: ${errored.map((c) => `${c.id} (${truncate(c.error ?? '', 160)})`).join('; ')}`;
            return text(body);
        },
        renderCall(args, theme) {
            const a = args as { element?: string; value?: unknown };
            return new Text(`${theme.fg('toolTitle', theme.bold('marimo ui'))} ${theme.fg('dim', `${a.element ?? ''} = ${truncate(JSON.stringify(a.value) ?? '', 60)}`)}`, 0, 0);
        },
    });

    pi.registerTool({
        name: 'marimo_check',
        label: 'marimo check',
        prepareArguments: dropNulls,
        description:
            'Lint marimo notebook files with `marimo check`: graph breakers (multiply defined names, cycles, import *), runtime hazards and formatting, each with the rule code, line, and a hint. `fix` rewrites the files for the fixable ones (`unsafe` also removes empty cells). Works on files on disk, open or not; for a notebook open in a kernel, prefer marimo_cells for errors, since the kernel knows more than the linter.',
        promptSnippet: 'Lint marimo notebook files with marimo check',
        parameters: Type.Object({
            paths: Type.Optional(Type.Array(Type.String(), { description: 'files or directories. default: the open notebook, else the working directory.' })),
            fix: Type.Optional(StringEnum(['no', 'safe', 'unsafe'] as const)),
            select: Type.Optional(Type.String({ description: 'comma-separated rule codes or prefixes to enable, e.g. MB,MR001' })),
            ignore: Type.Optional(Type.String({ description: 'comma-separated rule codes or prefixes to ignore' })),
        }),
        async execute(_id, params, signal, _update, ctx) {
            const cwd = ctx.cwd;
            const targets = params.paths !== undefined && params.paths.length > 0 ? params.paths.map((p) => expand(p, cwd)) : current !== null ? [current] : [cwd];
            const runner = notebooks.get(current ?? '')?.runner ?? chooseRunner(cwd, config.colab.runner);
            const args = ['check', '--format', 'json', '--ignore-scripts'];
            if (params.fix === 'safe' || params.fix === 'unsafe') args.push('--fix');
            if (params.fix === 'unsafe') args.push('--unsafe-fixes');
            if (params.select !== undefined) args.push('--select', params.select);
            if (params.ignore !== undefined) args.push('--ignore', params.ignore);
            const result = await runMarimo(runner, [...args, ...targets], cwd, { signal, timeoutMs: 120_000 });
            if (result.stdout.trim() === '' && result.code !== 0) fail(`marimo check failed (${String(result.code)}):\n${clip(result.stderr, 2000)}`);
            const report = parseLint(result.stdout);
            return text(lintText(report, params.fix !== undefined && params.fix !== 'no'), { issues: report.findings.length, fixed: report.fixed });
        },
        renderCall(args, theme) {
            const a = args as { paths?: string[]; fix?: string };
            return new Text(`${theme.fg('toolTitle', theme.bold('marimo check'))} ${theme.fg('dim', `${a.paths?.join(' ') ?? ''}${a.fix !== undefined && a.fix !== 'no' ? ` --fix${a.fix === 'unsafe' ? ' --unsafe-fixes' : ''}` : ''}`)}`, 0, 0);
        },
        renderResult(result, { expanded }, theme) {
            const first = result.content.find((c) => c.type === 'text');
            const body = first !== undefined && first.type === 'text' ? first.text : '';
            const d = result.details as { issues?: number; fixed?: number } | undefined;
            const line = d === undefined ? body.split('\n')[0] ?? '' : `${quantity(d.issues ?? 0, 'issue')}${(d.fixed ?? 0) > 0 ? `, ${d.fixed} fixed` : ''}`;
            return new Text(expanded ? body : theme.fg('dim', line), 0, 0);
        },
    });

    pi.registerTool({
        name: 'marimo_export',
        label: 'marimo export',
        prepareArguments: dropNulls,
        description:
            'Export a marimo notebook file with `marimo export`: html (runs the notebook, outputs included), html-wasm (runs in the browser), md (markdown with code fences), ipynb (Jupyter), script (a flat python script in dataflow order), pdf. Writes next to the notebook unless `output` is given.',
        promptSnippet: 'Export a marimo notebook to html, markdown, ipynb, or a script',
        parameters: Type.Object({
            path: Type.Optional(Type.String({ description: 'the notebook. default: the open one.' })),
            format: StringEnum(['html', 'html-wasm', 'md', 'ipynb', 'script', 'pdf'] as const),
            output: Type.Optional(Type.String({ description: 'output file (or directory for html-wasm).' })),
            include_outputs: Type.Optional(Type.Boolean({ description: 'for ipynb: run the notebook and include outputs. default false.' })),
        }),
        async execute(_id, params, signal, _update, ctx) {
            const cwd = ctx.cwd;
            const path = params.path !== undefined ? expand(params.path, cwd) : current ?? fail('no notebook given and none open');
            if (!existsSync(path)) fail(`${collapseHome(path)} does not exist`);
            const runner = notebooks.get(path)?.runner ?? chooseRunner(cwd, config.colab.runner);
            const ext: Record<string, string> = { html: '.html', 'html-wasm': '', md: '.md', ipynb: '.ipynb', script: '.script.py', pdf: '.pdf' };
            const output = params.output !== undefined ? expand(params.output, cwd) : path.replace(/\.py$/, '') + ext[params.format];
            const args = ['export', params.format, path, '-o', output];
            if (params.format === 'ipynb' && params.include_outputs === true) args.push('--include-outputs');
            if (wantsSandbox(path, config.colab.sandbox) && (params.format === 'html' || params.format === 'ipynb' || params.format === 'pdf')) args.push('--sandbox');
            const result = await runMarimo(runner, args, cwd, { signal, timeoutMs: 600_000 });
            if (result.code !== 0) fail(`marimo export failed (${String(result.code)}):\n${clip(`${result.stdout}\n${result.stderr}`.trim(), 3000)}`);
            const size = existsSync(output) && statSync(output).isFile() ? ` (${statSync(output).size} bytes)` : '';
            return text(`wrote ${collapseHome(output)}${size}${result.stderr.trim() !== '' ? `\n${clip(result.stderr.trim(), 1000)}` : ''}`, { output });
        },
        renderCall(args, theme) {
            const a = args as { path?: string; format?: string };
            return new Text(`${theme.fg('toolTitle', theme.bold('marimo export'))} ${theme.fg('dim', `${a.format ?? ''} ${a.path ?? ''}`)}`, 0, 0);
        },
    });

    pi.registerTool({
        name: 'marimo_convert',
        label: 'marimo convert',
        prepareArguments: dropNulls,
        description:
            'Convert a Jupyter notebook (.ipynb), a markdown notebook (.md) or a plain python script into a marimo notebook file with `marimo convert`. The result is checked with `marimo check` and its findings returned, since converted cells often redefine names that marimo needs unique. Then open it with marimo_open.',
        promptSnippet: 'Convert an .ipynb or .md into a marimo notebook',
        parameters: Type.Object({
            path: Type.String({ description: 'the .ipynb, .md, or .py to convert' }),
            output: Type.Optional(Type.String({ description: 'the marimo notebook to write. default: same name with .py' })),
        }),
        async execute(_id, params, signal, _update, ctx) {
            const cwd = ctx.cwd;
            const path = expand(params.path, cwd);
            if (!existsSync(path)) fail(`${collapseHome(path)} does not exist`);
            const output = params.output !== undefined ? expand(params.output, cwd) : path.replace(/\.(ipynb|md|py)$/, '') + (path.endsWith('.py') ? '.marimo.py' : '.py');
            if (existsSync(output) && statSync(output).size > 0) fail(`${collapseHome(output)} exists; give another output or remove it first`);
            const runner = chooseRunner(cwd, config.colab.runner);
            const result = await runMarimo(runner, ['convert', path, '-o', output], cwd, { signal, timeoutMs: 120_000 });
            if (result.code !== 0) fail(`marimo convert failed (${String(result.code)}):\n${clip(`${result.stdout}\n${result.stderr}`.trim(), 3000)}`);
            const lint = await runMarimo(runner, ['check', '--format', 'json', output], cwd, { signal, timeoutMs: 120_000 });
            const report = parseLint(lint.stdout);
            return text(`wrote ${collapseHome(output)}\n${lintText(report, false)}`, { output, issues: report.findings.length });
        },
        renderCall(args, theme) {
            const a = args as { path?: string };
            return new Text(`${theme.fg('toolTitle', theme.bold('marimo convert'))} ${theme.fg('dim', a.path ?? '')}`, 0, 0);
        },
    });

    // ---------------------------------------------------------- command --

    const VERBS = ['stop', 'status', 'open', 'mcp', 'list', 'close', 'app'] as const;
    /** `marimo run` children, by notebook path: the app view of a notebook. */
    const apps = new Map<string, Started>();

    pi.registerCommand('colab', {
        description: 'pair with the agent on a marimo notebook: /colab <notebook.py> opens it in a shared kernel and in the browser',
        getArgumentCompletions: (prefix) => {
            const items = VERBS.filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
            const here = notebooksIn(process.cwd()).map((p) => basename(p)).filter((n) => n.startsWith(prefix));
            return [...items, ...here.map((n) => ({ value: n, label: n }))].length > 0 ? [...items, ...here.map((n) => ({ value: n, label: n }))] : null;
        },
        handler: async (args, ctx) => {
            uiHost = ctx.ui;
            load();
            const arg = args.trim();
            const cwd = ctx.cwd;
            const [verb, ...rest] = arg.split(/\s+/);
            const say = (message: string, level: 'info' | 'error' | 'warning' = 'info') => ctx.ui.notify(message, level);
            try {
                if (arg === '' || verb === 'status' || verb === 'list') {
                    if (notebooks.size === 0) {
                        const here = notebooksIn(cwd);
                        const servers = await discover();
                        say(`nothing open. ${here.length > 0 ? `notebooks here: ${here.map((p) => basename(p)).join(', ')}` : 'no notebooks in this directory'}${servers.length > 0 ? `; servers running: ${servers.map((s) => s.url ?? s.id).join(', ')}` : ''}`);
                        return;
                    }
                    for (const [path, a] of notebooks) say(`${collapseHome(path)}${path === current ? ' (current)' : ''} · ${a.session.mirror.summary()} · ${a.session.browserUrl}`);
                    return;
                }
                if (verb === 'stop' || verb === 'close') {
                    const target = rest[0] !== undefined ? expand(rest[0], cwd) : current;
                    if (target === null) return say('nothing to stop', 'warning');
                    say(await closeNotebook(target));
                    return;
                }
                if (verb === 'open') {
                    const a = attachedFor(rest[0], cwd);
                    openBrowser(a.session.browserUrl);
                    say(`opened ${a.session.browserUrl}`);
                    return;
                }
                if (verb === 'app') {
                    // the notebook as its readers see it: code hidden, outputs
                    // live, on its own server since `marimo run` is a mode
                    const path = rest[0] !== undefined ? expand(rest[0], cwd) : current;
                    if (path === null) return say('which notebook? /colab app <notebook.py>', 'warning');
                    const running = apps.get(path);
                    if (running !== undefined) {
                        openBrowser(running.url);
                        return say(`app already running at ${running.url}`);
                    }
                    const runner = notebooks.get(path)?.runner ?? chooseRunner(cwd, config.colab.runner);
                    const child = await start({ runner, cwd, target: path, port: config.colab.port + 100, sandbox: wantsSandbox(path, config.colab.sandbox), mcp: false, mode: 'run' });
                    apps.set(path, child);
                    started.set(child.url, child);
                    openBrowser(child.url);
                    say(`app at ${child.url} (${child.command})`);
                    return;
                }
                if (verb === 'mcp') {
                    const a = attachedFor(rest[0], cwd);
                    const url = `${a.address.url}/mcp/server`;
                    say(`marimo MCP (tools mode): ${url}\nclaude mcp add --transport http marimo ${url}${a.started === null ? '\n(this server was not started here; --mcp may be off)' : config.colab.mcp ? '' : '\n([colab] mcp is off, so the endpoint is not served)'}`);
                    return;
                }
                // a path: open it, for the person in the browser and for the agent
                ctx.ui.setStatus('colab', `⬢ opening ${basename(arg)}…`);
                const { attached, note } = await open(arg, cwd);
                if (config.colab.browser) openBrowser(attached.session.browserUrl);
                say(`${note}\n${attached.session.browserUrl}`);
                const { body } = await overview(attached);
                // the agent learns what the person opened, the same way it
                // learns a cwd change: a message after the person's, not a
                // prompt rewrite.
                pi.sendMessage(
                    {
                        customType: 'colab',
                        content: `The person opened a marimo notebook with /colab; it is now the current notebook for the marimo_* tools, and they are looking at it in the browser on the same kernel.\n${note}\n\n${body}`,
                        display: true,
                        details: { path: attached.session.path, url: attached.address.url },
                    },
                    { deliverAs: 'followUp' },
                );
            } catch (error) {
                refreshStatus();
                say((error as Error).message, 'error');
            }
        },
    });

    pi.registerMessageRenderer('colab', (message, options, theme) => {
        const details = message.details as { path?: string; url?: string } | undefined;
        const line = `${theme.fg('accent', 'colab')}  ${theme.fg('text', collapseHome(details?.path ?? ''))}  ${theme.fg('dim', details?.url ?? '')}`;
        const content = typeof message.content === 'string' ? message.content : '';
        return new Text(options.expanded ? `${line}\n${theme.fg('dim', content)}` : line, options.outputPad, 0);
    });
}
