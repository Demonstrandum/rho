#!/usr/bin/env bun
// end-to-end smoke test for pi + rho.
//
// it answers one question: does the current pi, loading this checkout as a
// package, start, load every extension, run a turn with a tool call, render a
// terminal session, and exit cleanly.
//
// the run is hermetic. PI_CODING_AGENT_DIR, XDG_CONFIG_HOME, and the working
// directory all point into a temporary tree, so the test never reads or writes
// the host's pi config, sessions, credentials, or rho.toml. the model is the
// local server in ./mock-provider.ts, so no API key and no network are needed.
//
//   bun ci/smoke.ts            run against the checkout this file lives in
//   bun ci/smoke.ts --keep     keep the temporary tree and print its path
//
// the docker image in ./Dockerfile runs this as its entrypoint.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
    startMockProvider,
    MOCK_PROVIDER_ID,
    MOCK_MODEL_ID,
    TOOL_MARKER,
    REPLY_TRIGGER,
    REPLY_SWAPPED,
    type MockProvider,
} from './mock-provider';

const REPO = resolve(import.meta.dir, '..');
const KEEP = process.argv.includes('--keep');

// substrings that mean a crash, a failed import, or an extension that threw.
// they are matched against everything pi writes on either stream.
const CRASH_PATTERNS: readonly string[] = [
    'TypeError',
    'ReferenceError',
    'SyntaxError',
    'is not a function',
    'Cannot find module',
    'Cannot find package',
    'Failed to resolve',
    'Unhandled error',
    'unhandledRejection',
    'Extension error',
    'Failed to load extension',
    'error loading extension',
    'ERR_MODULE_NOT_FOUND',
];

interface RunResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    /** stdout and stderr together, for pattern checks that do not care which. */
    readonly output: string;
}

interface Failure {
    readonly check: string;
    readonly detail: string;
}

const failures: Failure[] = [];
let checked = 0;

function check(name: string, ok: boolean, detail: string): void {
    checked += 1;
    if (ok) {
        console.log(`  ok    ${name}`);
        return;
    }
    console.log(`  FAIL  ${name}`);
    failures.push({ check: name, detail });
}

function section(name: string): void {
    console.log(`\n${name}`);
}

function checkNoCrash(name: string, result: RunResult): void {
    const hits = CRASH_PATTERNS.filter((pattern) => result.output.includes(pattern));
    check(`${name}: no crash output`, hits.length === 0, `matched: ${hits.join(', ')}\n${tail(result.output)}`);
}

function tail(text: string, lines = 40): string {
    return text.split('\n').slice(-lines).join('\n');
}

interface Workspace {
    readonly root: string;
    readonly agentDir: string;
    readonly configHome: string;
    readonly project: string;
    readonly env: Record<string, string>;
}

function makeWorkspace(provider: MockProvider): Workspace {
    const root = mkdtempSync(join(tmpdir(), 'rho-smoke-'));
    const agentDir = join(root, 'agent');
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    for (const dir of [agentDir, configHome, project]) mkdirSync(dir, { recursive: true });

    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
        packages: [REPO],
        defaultProvider: MOCK_PROVIDER_ID,
        defaultModel: MOCK_MODEL_ID,
    }, null, 2));

    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
        providers: {
            [MOCK_PROVIDER_ID]: {
                baseUrl: provider.baseUrl,
                api: 'openai-completions',
                apiKey: 'mock-key',
                models: [{
                    id: MOCK_MODEL_ID,
                    name: 'Mock 1',
                    reasoning: false,
                    input: ['text'],
                    contextWindow: 128000,
                    maxTokens: 4096,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                }],
            },
        },
    }, null, 2));

    // a file for the agent to see, and a git repo so pi's project handling has
    // something normal to work with.
    writeFileSync(join(project, 'README.md'), '# smoke project\n');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: project });

    return {
        root,
        agentDir,
        configHome,
        project,
        env: {
            ...process.env as Record<string, string>,
            PI_CODING_AGENT_DIR: agentDir,
            PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions'),
            XDG_CONFIG_HOME: configHome,
            HOME: root,
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            PI_TELEMETRY: '0',
            TERM: 'xterm-256color',
            COLUMNS: '120',
            LINES: '40',
        },
    };
}

async function run(
    argv: readonly string[],
    workspace: Workspace,
    options: { stdin?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
    const proc = Bun.spawn(argv, {
        cwd: workspace.project,
        env: workspace.env,
        stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
        stdout: 'pipe',
        stderr: 'pipe',
    });

    const timeoutMs = options.timeoutMs ?? 120_000;
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    clearTimeout(timer);

    return { code, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/**
 * run a command on a pseudo-terminal, so pi starts its TUI instead of print
 * mode, and feed it keystrokes on a timetable. `script` is the portable way to
 * get a pty from a shell; its argument order differs between util-linux and
 * BSD. the keystrokes are written by a subshell rather than piped from this
 * process, because the TUI must still be running when each one arrives.
 */
function ptyCommand(command: string, keys: readonly PtyKey[]): string[] {
    const script = process.platform === 'darwin'
        ? `script -q /dev/null bash -lc ${shellQuote(command)}`
        : `script -qec ${shellQuote(command)} /dev/null`;
    const feed = keys
        .map((key) => `sleep ${key.afterSeconds}; printf ${shellQuote(key.text)};`)
        .join(' ');
    // the last resort kill keeps a TUI that refuses to quit from holding the
    // pipe open, which would outlive this process's own timeout.
    return ['bash', '-c', `{ ${feed} pkill -f ${shellQuote(command)} 2>/dev/null; } | ${script}`];
}

interface PtyKey {
    /** how long to wait before sending, in seconds. */
    readonly afterSeconds: number;
    /** passed to printf, so escapes such as \003 (ctrl+c) work. */
    readonly text: string;
}

function shellQuote(text: string): string {
    return `'${text.replaceAll("'", `'\\''`)}'`;
}

interface JsonEvent {
    readonly type: string;
    readonly [key: string]: unknown;
}

function parseJsonl(text: string): JsonEvent[] {
    const events: JsonEvent[] = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            events.push(JSON.parse(trimmed) as JsonEvent);
        } catch {
            // a non-event line on stdout is not a parse failure of the stream.
        }
    }
    return events;
}

function assistantText(events: readonly JsonEvent[]): string {
    const parts: string[] = [];
    for (const event of events) {
        if (event.type !== 'message_end') continue;
        const message = event.message as { role?: string; content?: unknown } | undefined;
        if (message?.role !== 'assistant') continue;
        if (typeof message.content === 'string') parts.push(message.content);
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
            const typed = block as { type?: string; text?: string };
            if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text);
        }
    }
    return parts.join('\n');
}

async function main(): Promise<number> {
    const provider = startMockProvider();
    const workspace = makeWorkspace(provider);
    console.log(`pi:        ${Bun.which('pi') ?? '(not on PATH)'}`);
    console.log(`rho:       ${REPO}`);
    console.log(`mock:      ${provider.baseUrl}`);
    console.log(`workspace: ${workspace.root}`);

    section('preflight');
    const gate = await run(['bun', join(REPO, 'tools/version-gate.mjs')], workspace, { timeoutMs: 60_000 });
    check('the version gate passes', gate.code === 0, tail(gate.output));
    const doctor = await run(['bun', join(REPO, 'tools/preflight.ts')], workspace, { timeoutMs: 60_000 });
    check('the doctor reports no errors', doctor.code === 0, tail(doctor.output));

    section('version');
    const version = await run(['pi', '--version'], workspace, { timeoutMs: 60_000 });
    check('pi --version exits 0', version.code === 0, tail(version.output));
    console.log(`  pi version ${version.stdout.trim()}`);

    section('models');
    const models = await run(['pi', '--list-models'], workspace, { timeoutMs: 60_000 });
    check('the mock model is registered', models.output.includes(MOCK_MODEL_ID), tail(models.output));
    checkNoCrash('--list-models', models);

    section('headless turn');
    const turn = await run([
        'pi', '-p', '--mode', 'json',
        '--model', `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
        'run the smoke check',
    ], workspace, { timeoutMs: 180_000 });

    check('exits 0', turn.code === 0, tail(turn.output));
    checkNoCrash('headless turn', turn);

    const events = parseJsonl(turn.stdout);
    const types = new Set(events.map((event) => event.type));
    check('emits a session header', types.has('session'), [...types].join(', '));
    check('emits agent_end', types.has('agent_end'), [...types].join(', '));

    const toolEnd = events.find((event) => event.type === 'tool_execution_end');
    check('the tool call ran', toolEnd !== undefined, [...types].join(', '));
    check('the tool result reached the session',
        JSON.stringify(toolEnd ?? {}).includes(TOOL_MARKER),
        JSON.stringify(toolEnd ?? {}).slice(0, 400));

    const text = assistantText(events);
    check('the assistant replied', text.trim().length > 0, JSON.stringify(events.slice(-3)));

    section('extensions');
    // the wordswap extension rewrites finalized assistant text on message_end.
    // the mock reply carries a word from the swap list, so the swapped word
    // appearing here proves the hook ran inside a real session.
    check('wordswap rewrote the reply',
        text.includes(REPLY_SWAPPED) && !text.includes(REPLY_TRIGGER),
        `reply: ${text.trim()}`);

    // the system prompt is assembled by system-prompt.ts from system/prompt.md;
    // the mock server keeps what it was sent.
    const prompt = provider.calls[0]?.systemPrompt ?? '';
    check('the rho system prompt was sent', prompt.includes('personal rules'), `${prompt.length} chars`);
    check('the writer rules were included', prompt.includes('ASD-STE100'), `${prompt.length} chars`);
    check('the vocabulary list was included', prompt.includes(REPLY_TRIGGER), `${prompt.length} chars`);

    // rho.toml is optional; generating it exercises the config writer and the
    // loader path that reads it. env-paths, which picks the location, ignores
    // XDG_CONFIG_HOME on macOS.
    const configFile = process.platform === 'darwin'
        ? join(workspace.root, 'Library', 'Preferences', 'rho', 'rho.toml')
        : join(workspace.configHome, 'rho', 'rho.toml');
    const init = await run(['bun', join(REPO, 'tools/init-config.ts')], workspace, { timeoutMs: 60_000 });
    check('rho.toml is generated', init.code === 0 && existsSync(configFile), tail(init.output));

    section('terminal session');
    // a pty run is the only way to reach the TUI code: the startup header, the
    // input field patch, the box renderer, the footer, and the spinner.
    const model = `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`;
    const tui = await run(
        ptyCommand(`cd ${workspace.project} && pi --model ${model}`, [
            // let the startup header settle, type a prompt, let the turn finish,
            // then quit with two ctrl+c.
            { afterSeconds: 6, text: 'run the smoke check\\r' },
            // ctrl+d quits when the editor is empty; ctrl+c only clears it.
            { afterSeconds: 18, text: '\\004' },
            { afterSeconds: 2, text: '\\004' },
            { afterSeconds: 4, text: '' },
        ]),
        workspace,
        { timeoutMs: 120_000 },
    );
    const screen = tui.output;
    check('the rho header rendered',
        ['prompts', 'skills', 'commands', 'themes'].every((label) => screen.includes(label)),
        tail(screen, 60));
    check('the reply rendered', screen.includes(REPLY_SWAPPED), tail(screen, 60));
    check('exits on ctrl+d', tui.code === 0, `exit ${tui.code}\n${tail(screen, 20)}`);
    checkNoCrash('terminal session', tui);

    section('checks after a config file exists');
    const withConfig = await run([
        'pi', '-p', '--mode', 'json', '--model', model, 'run the smoke check again',
    ], workspace, { timeoutMs: 180_000 });
    check('a second run with rho.toml present exits 0', withConfig.code === 0, tail(withConfig.output));
    checkNoCrash('second run', withConfig);

    provider.stop();

    console.log(`\n${checked - failures.length}/${checked} checks passed`);
    for (const failure of failures) {
        console.log(`\n--- ${failure.check}\n${failure.detail}`);
    }

    if (KEEP) {
        console.log(`\nworkspace kept: ${workspace.root}`);
    } else {
        rmSync(workspace.root, { recursive: true, force: true });
    }

    return failures.length === 0 ? 0 : 1;
}

process.exit(await main());
