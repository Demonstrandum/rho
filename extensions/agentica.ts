// agentica: a tool that runs python which can call MCP tools via the Agentica
// MCP Runtime. ported from MathisWellmann/nixos-config's pi-agent.nix, but
// off by default. the nix build gated it behind a build flag; rho has no build
// step, so the gate is runtime and explicit: the tool is only registered when
// RHO_AGENTICA_RUNTIME points at an agentica-mcp-runtime checkout. with the env
// unset the extension is a no-op, so it never appears unless i opt in.
//
// env:
//   RHO_AGENTICA_RUNTIME  absolute path to the agentica-mcp-runtime (required;
//                         its presence is the explicit enable)
//   RHO_AGENTICA_PYTHON   python interpreter to run the helper with
//                         (default: <runtime>/.venv/bin/python)

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'agentica_helper.py');
const EXEC_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

function agenticaTool(runtime: string, python: string) {
    return defineTool({
        name: 'agentica',
        label: 'Agentica',
        description:
            'Execute Python code that can call MCP tools via the Agentica MCP Runtime. ' +
            'MCP tools are available as async functions. Use `await` to call them and `print()` to surface results. ' +
            'Minimize calls: do as much as possible in a single call. ' +
            'Use asyncio.gather() for parallel tool calls. Keep output concise to save context.',
        parameters: Type.Object({
            code: Type.String({
                description:
                    'Python code to execute. MCP tools from discovered MCP servers are available as async functions.\n' +
                    'Example:\n  result = await some_mcp_tool(arg1, arg2)\n  print(result)\n\n' +
                    'For parallel calls:\n  data1, data2 = await asyncio.gather(tool1(), tool2())',
            }),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const dir = mkdtempSync(join(tmpdir(), 'agentica-'));
            const codeFile = join(dir, `${randomUUID()}.py`);
            writeFileSync(codeFile, params.code);
            try {
                const { stdout, stderr } = await execFileAsync(python, [HELPER, runtime, codeFile], {
                    timeout: EXEC_TIMEOUT_MS,
                    maxBuffer: MAX_BUFFER,
                    signal,
                });
                const output = (stdout || '').trim();
                const errorMsg = (stderr || '').trim();
                if (errorMsg && !output) {
                    return { content: [{ type: 'text', text: `ERROR:\n${errorMsg}` }], details: {}, isError: true };
                }
                return { content: [{ type: 'text', text: output || '(no output)' }], details: {} };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: 'text', text: `Agentica execution failed:\n${message}` }],
                    details: {},
                    isError: true,
                };
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        },
    });
}

export default function (pi: ExtensionAPI) {
    const runtime = process.env.RHO_AGENTICA_RUNTIME;
    if (!runtime) {
        return; // not explicitly enabled: register nothing.
    }
    const python = process.env.RHO_AGENTICA_PYTHON ?? join(runtime, '.venv', 'bin', 'python');
    pi.registerTool(agenticaTool(runtime, python));
}
