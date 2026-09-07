#!/usr/bin/env bun
// prints the whole system prompt a real session sends: pi's own prompt, the
// tool guidelines, AGENTS.md, the skill listing, and rho's fragments.
//
//   bun tools/prompt-full.ts            the provider payload's system text
//   bun tools/prompt-full.ts --json     the full payload, for inspecting the rest
//
// it runs pi headlessly with one extra extension that dumps the payload from
// before_provider_request and exits before the request leaves the machine, so
// no tokens are spent and no api key is needed beyond what pi checks at start.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DUMP_ENV = 'RHO_PROMPT_DUMP';

const dumper = `
import { writeFileSync } from 'node:fs';
export default function (pi) {
    pi.on('before_provider_request', (event) => {
        writeFileSync(process.env['${DUMP_ENV}'], JSON.stringify(event.payload));
        process.exit(0);
    });
}
`;

/** the system text as each provider serialises it. */
const systemText = (payload: unknown): string => {
    if (typeof payload !== 'object' || payload === null) return '';
    const record = payload as Record<string, unknown>;

    // anthropic: string, or an array of {type:'text',text}
    const system = record['system'];
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system
            .map((block) => (typeof block === 'object' && block !== null ? String((block as Record<string, unknown>)['text'] ?? '') : String(block)))
            .join('\n');
    }

    // google: {systemInstruction: {parts: [{text}]}}
    const instruction = record['systemInstruction'];
    if (typeof instruction === 'object' && instruction !== null) {
        const parts = (instruction as Record<string, unknown>)['parts'];
        if (Array.isArray(parts)) {
            return parts.map((p) => String((p as Record<string, unknown>)['text'] ?? '')).join('\n');
        }
    }

    // openai-completions: the first message with role system or developer
    const messages = record['messages'];
    if (Array.isArray(messages)) {
        const first = messages.find((m) => {
            const role = (m as Record<string, unknown>)['role'];
            return role === 'system' || role === 'developer';
        });
        if (first) {
            const content = (first as Record<string, unknown>)['content'];
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
                return content.map((c) => String((c as Record<string, unknown>)['text'] ?? '')).join('\n');
            }
        }
    }

    return '';
};

const dir = mkdtempSync(join(tmpdir(), 'rho-prompt-'));
const extensionPath = join(dir, 'dump-payload.ts');
const dumpPath = join(dir, 'payload.json');
writeFileSync(extensionPath, dumper);

const passthrough = process.argv.slice(2).filter((arg) => arg !== '--json');
const wantsJson = process.argv.includes('--json');

const child = Bun.spawnSync({
    cmd: ['pi', '-p', 'x', '--mode', 'text', '-e', extensionPath, ...passthrough],
    env: { ...process.env, [DUMP_ENV]: dumpPath },
    stdout: 'pipe',
    stderr: 'pipe',
});

let payload: unknown;
try {
    payload = JSON.parse(readFileSync(dumpPath, 'utf8'));
} catch {
    process.stderr.write(new TextDecoder().decode(child.stderr));
    process.stderr.write(new TextDecoder().decode(child.stdout));
    process.stderr.write('\nno payload captured: pi exited before a provider request was built.\n');
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
}
rmSync(dir, { recursive: true, force: true });

if (wantsJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
    const text = systemText(payload).trim();
    if (text.length === 0) {
        process.stderr.write('payload carried no system text; run with --json to see its shape.\n');
        process.exit(1);
    }
    process.stdout.write(text + '\n');
}
