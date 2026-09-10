#!/usr/bin/env bun
// bun extensions/lib/disenshittification.demo.ts
// runs the transforms over real text: pi's own system prompt head, a bundled
// tool description, and a torture case of protected spans.
import { disenshittify, disenshittifyMarkdown, mask } from './disenshittification';

const RESET = '\u001b[0m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const DIM = '\u001b[2m';

const piHead = (): string => {
    const path = `${process.env['HOME']}/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`;
    const source = require('node:fs').readFileSync(path, 'utf8') as string;
    const match = /let prompt = `([\s\S]*?)`;\n/.exec(source);
    // the template's holes, filled the way a real session fills them.
    const filled: Record<string, string> = {
        toolsList: ['- read: Read file contents', '- bash: Execute bash commands (ls, grep, find, etc.)'].join('\n'),
        guidelines: ['- Use bash for file operations like ls, rg, find', '- Be concise in your responses'].join('\n'),
        readmePath: '/opt/pi/README.md',
        docsPath: '/opt/pi/docs',
        examplesPath: '/opt/pi/examples',
    };
    return (match?.[1] ?? '').replace(/\$\{([^}]*)\}/g, (_, name: string) => filled[name] ?? name);
};

const toolDescription = [
    'Think-in-Code — the core philosophy: the bytes your code processes never enter your',
    'conversation memory; only what you console.log() does. Reading a 700 KB log directly',
    'means 700 KB of your remaining reasoning capacity gets spent on raw bytes.',
    '  - Single observational command whose entire short output you intend to consume',
    '    verbatim (whoami, pwd, git status on a clean tree) — Bash is simpler',
    '  - You need to keep a long-running process alive — pass `background: true` to detach',
    'Latency = max(fetch latency) + sum(per-source index write time) — cache hits skip both.',
].join('\n');

const torture = [
    'The flag `--force` — and the range 2014–2018 — stay put.',
    '',
    'A path /usr/bin/env — and a url https://example.com/a—b — are bytes, not prose.',
    '',
    '<project_context path="AGENTS.md">Read it. Then act.</project_context>',
    '',
    'Inline <t>abc. def</t> markup pins its paragraph to one line.',
    '',
    'A “quoted” span with an ellipsis… and a ﬁle ligature, plus 5\u2009000 as a number.',
    '',
    '```',
    'const x = a — b; // untouched inside the fence',
    '```',
    '',
    'Conditions before actions — one action per step. Two sentences share this line.',
].join('\n');

/** longest common subsequence over lines, so unchanged lines stay aligned. */
const diff = (before: readonly string[], after: readonly string[]): string[] => {
    const rows = before.length;
    const columns = after.length;
    const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
    for (let i = rows - 1; i >= 0; i -= 1) {
        for (let j = columns - 1; j >= 0; j -= 1) {
            table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const out: string[] = [];
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
        if (before[i] === after[j]) {
            out.push(`  ${DIM}${before[i]}${RESET}`);
            i += 1;
            j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            out.push(`${RED}- ${before[i]}${RESET}`);
            i += 1;
        } else {
            out.push(`${GREEN}+ ${after[j]}${RESET}`);
            j += 1;
        }
    }
    while (i < rows) out.push(`${RED}- ${before[i++]}${RESET}`);
    while (j < columns) out.push(`${GREEN}+ ${after[j++]}${RESET}`);
    return out;
};

const show = (title: string, before: string, after: string): void => {
    console.log(`\n${DIM}${'-'.repeat(72)}${RESET}\n${title}\n`);
    for (const line of diff(before.split('\n'), after.split('\n'))) console.log(line);
};

const check = (label: string, transform: (text: string) => string, sample: string): void => {
    const once = transform(sample);
    const twice = transform(once);
    const stable = once === twice;
    console.log(`${stable ? GREEN : RED}${stable ? 'idempotent' : 'NOT IDEMPOTENT'}${RESET} ${DIM}${label}${RESET}`);
};

const head = piHead();
show("pi's system prompt head (dist/core/system-prompt.js)", head, disenshittifyMarkdown(head));
show('a bundled tool description', toolDescription, disenshittify(toolDescription));
show('protected spans', torture, disenshittifyMarkdown(torture));

console.log(`\n${DIM}${'-'.repeat(72)}${RESET}\n`);
check('disenshittify / pi head', disenshittify, head);
check('disenshittifyMarkdown / pi head', disenshittifyMarkdown, head);
check('disenshittify / tool description', disenshittify, toolDescription);
check('disenshittifyMarkdown / torture', disenshittifyMarkdown, torture);

const spans = mask(torture).spans;
console.log(`\n${DIM}masked spans (${spans.length}):${RESET}`);
for (const span of spans) console.log(`  ${JSON.stringify(span)}`);
