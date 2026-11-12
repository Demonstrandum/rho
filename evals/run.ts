#!/usr/bin/env bun
// runs the scenarios against the model matrix with the live prompt (or a
// variant), grades each run, and writes a report. see evals/README.md.
//
//   bun evals/run.ts                                   every scenario, every model in lib/models.ts
//   bun evals/run.ts --list                            the scenarios and what each observes
//   bun evals/run.ts --coverage                        prompt sections against the scenarios that observe them
//   bun evals/run.ts --models anthropic/claude-haiku-5-5:low --scenarios docs-deploy --repeat 3
//   bun evals/run.ts --out evals/results/big --shard 2/4   one quarter of the jobs; rerun to resume
//   bun evals/run.ts --report evals/results/big        rebuild the report from what is there
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseModelSpec, specLabel, type ThinkingLevel } from './lib/agent';
import { INTENTS, type Fragment } from './lib/intents';
import { matrixSpecs, parseModels, unknownModels } from './lib/models';
import { buildReport, coverage, loadResults } from './lib/report';
import { finished, runOne, schedule, type Job } from './lib/runner';
import type { Scenario } from './lib/scenario';

const DEFAULT_JUDGE = 'anthropic/claude-opus-5-5:high';

const { values } = parseArgs({
    options: {
        models: { type: 'string' },
        thinking: { type: 'string', default: 'medium' },
        scenarios: { type: 'string' },
        variant: { type: 'string' },
        repeat: { type: 'string', default: '2' },
        concurrency: { type: 'string', default: '12' },
        'per-model': { type: 'string', default: '3' },
        shard: { type: 'string' },
        out: { type: 'string' },
        judge: { type: 'string', default: DEFAULT_JUDGE },
        label: { type: 'string' },
        keep: { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        coverage: { type: 'boolean', default: false },
        report: { type: 'string' },
    },
});

const evalsDir = import.meta.dir;
const piVersion = (): string =>
    (JSON.parse(readFileSync(join(evalsDir, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')) as { version: string }).version;

async function loadScenarios(only: readonly string[] | null): Promise<Scenario[]> {
    const files = readdirSync(join(evalsDir, 'scenarios')).filter((f) => f.endsWith('.ts')).sort();
    const all: Scenario[] = [];
    for (const file of files) all.push(((await import(join(evalsDir, 'scenarios', file))) as { default: Scenario }).default);
    if (only === null) return all;
    const unknown = only.filter((name) => !all.some((s) => s.name === name));
    if (unknown.length > 0) throw new Error(`unknown scenarios: ${unknown.join(', ')}`);
    return all.filter((s) => only.includes(s.name));
}

function writeReport(outDir: string, header: string): string {
    const path = join(outDir, 'report.md');
    writeFileSync(path, buildReport(loadResults(outDir), header));
    return path;
}

if (values.report) {
    const dir = resolve(values.report);
    console.log(writeReport(dir, `# eval ${basename(dir)}\n\n- pi ${piVersion()}\n- each cell counts passed of graded items; n/a is left out`));
    process.exit(0);
}

const scenarios = await loadScenarios(values.scenarios ? values.scenarios.split(',').map((s) => s.trim()) : null);

if (values.list) {
    for (const s of scenarios) {
        const intents = [...new Set([...s.checks, ...s.criteria].map((c) => c.intent))];
        console.log(`${s.name.padEnd(20)} ${s.seed ? '[seeded] ' : ''}${s.prompt.split('\n')[0]!.slice(0, 90)}`);
        console.log(`${''.padEnd(20)} observes: ${intents.join(', ')}`);
    }
    process.exit(0);
}

if (values.coverage) {
    const fragments: Fragment[] = ['personal-rules.md', 'writer-rules.md', 'orthography.md', 'prose-style.md', 'vocabulary.md'];
    const bytes = Object.fromEntries(fragments.map((f) => [f, statSync(join(evalsDir, '..', 'system', f)).size])) as Record<Fragment, number>;
    console.log(coverage(scenarios, [], bytes));
    process.exit(0);
}

const thinking = values.thinking as ThinkingLevel;
const specs = values.models ? parseModels(values.models, thinking) : matrixSpecs(thinking);
const missing = unknownModels(specs);
if (missing.length > 0) {
    console.error(`pi does not list: ${missing.join(', ')}`);
    process.exit(1);
}
// --judge none leaves every run for the person to review alone.
const judgeSpec = values.judge === 'none' ? null : parseModelSpec(values.judge, 'high');
const variant = values.variant ? resolve(values.variant) : null;
const repeats = Math.max(1, Number(values.repeat));

let jobs: Job[] = specs.flatMap((spec) => scenarios.flatMap((scenario) =>
    Array.from({ length: repeats }, (_, i) => ({ spec, scenario, repeat: repeats > 1 ? i + 1 : 0 }))));
if (values.shard) {
    const [k, n] = values.shard.split('/').map(Number) as [number, number];
    if (!(n >= 1 && k >= 1 && k <= n)) throw new Error(`--shard takes k/n with 1 <= k <= n, not ${values.shard}`);
    jobs = jobs.filter((_, index) => index % n === k - 1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = values.out
    ? resolve(values.out)
    : join(evalsDir, 'results', [stamp, variant ? basename(variant) : 'live', values.label].filter(Boolean).join('-'));
mkdirSync(outDir, { recursive: true });

const pending = jobs.filter((job) => finished(job, outDir) === null);
console.log(`${jobs.length} runs, ${jobs.length - pending.length} already done -> ${outDir}`);
const options = { judge: judgeSpec, outDir, variant, keep: values.keep };
await schedule(pending, { total: Math.max(1, Number(values.concurrency)), perModel: Math.max(1, Number(values['per-model'])) }, (job) => job.spec.model, async (job) => {
    const result = await runOne(job, options);
    const counted = result.graded.filter((g) => g.outcome !== 'n/a');
    const passed = counted.filter((g) => g.outcome === 'pass').length;
    console.log(`${specLabel(job.spec).padEnd(26)} ${job.scenario.name.padEnd(20)} ${`${passed}/${counted.length}`.padStart(6)}${result.error ? `  ${result.error.slice(0, 80)}` : ''}`);
    return result;
});

const header = [
    `# eval ${basename(outDir)}`,
    '',
    `- pi ${piVersion()}, prompt ${variant ? `variant ${variant}` : 'live (system/)'}`,
    `- judge ${judgeSpec ? specLabel(judgeSpec) : "none"}, ${repeats} run(s) per cell${values.shard ? `, shard ${values.shard}` : ''}`,
    `- intents observed: ${Object.keys(INTENTS).length}; each cell counts passed of graded items; n/a is left out`,
].join('\n');
console.log(`report: ${writeReport(outDir, header)}`);
