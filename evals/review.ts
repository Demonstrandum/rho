#!/usr/bin/env bun
// review the runs of one results directory, by hand and with a judge model.
//
//   bun evals/review.ts <dir>                      the review UI, on http://localhost:4777
//   bun evals/review.ts <dir> --judge              a judge review for every run that has none
//   bun evals/review.ts <dir> --judge anthropic/claude-sonnet-5-5:high --concurrency 6
//   bun evals/review.ts <dir> --summary            ratings and findings per model, as markdown
//
// reviews live beside each run in reviews/<author>.json; the person's is
// reviews/human.json. nothing here needs the scenario modules once run.json
// exists, so a results directory can be reviewed on any machine.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseModelSpec, specLabel } from './lib/agent';
import { judgeRun } from './lib/judge';
import { blocksOf, HUMAN, loadReviews, saveReview, type Review } from './lib/review';
import { loadRuns, summarise, type StoredRun } from './lib/review-store';
import { loadRules } from './lib/rules';
import { schedule } from './lib/runner';

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        port: { type: 'string', default: '4777' },
        judge: { type: 'string' },
        concurrency: { type: 'string', default: '6' },
        summary: { type: 'boolean', default: false },
    },
});

const root = resolve(positionals[0] ?? '');
if (!positionals[0] || !existsSync(root)) {
    console.error('usage: bun evals/review.ts <results dir> [--judge [model]] [--summary] [--port n]');
    process.exit(1);
}

const read = (run: StoredRun, file: string): string => {
    const path = join(run.dir, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

if (values.summary) {
    const text = summarise(await loadRuns(root));
    writeFileSync(join(root, 'review-summary.md'), text);
    console.log(text);
    process.exit(0);
}

// --judge with no value comes through as an empty string.
if (values.judge !== undefined) {
    const spec = parseModelSpec(values.judge || 'anthropic/claude-opus-5-5:high', 'high');
    const author = `judge:${specLabel(spec)}`;
    const runs = (await loadRuns(root)).filter((r) => !loadReviews(r.dir).some((v) => v.author === author));
    console.log(`${runs.length} runs to judge with ${author}`);
    // every job here calls the same judge model, so one limit covers it.
    const limit = Number(values.concurrency);
    await schedule(runs, { total: limit, perModel: limit }, () => author, async (run) => {
        const review = await judgeRun(spec, run.info, blocksOf(run.info, read(run, 'events.jsonl')), read(run, 'diff.patch'));
        saveReview(run.dir, review);
        console.log(`${run.key.padEnd(48)} ${review.annotations.length} findings`);
    });
    process.exit(0);
}

const rules = loadRules();
const page = join(import.meta.dir, 'review.html');

async function runByKey(key: string): Promise<StoredRun | undefined> {
    return (await loadRuns(root)).find((r) => r.key === key);
}

const server = Bun.serve({
    port: Number(values.port),
    async fetch(request) {
        const url = new URL(request.url);
        const key = url.searchParams.get('key') ?? '';
        switch (url.pathname) {
            case '/':
                return new Response(Bun.file(page), { headers: { 'content-type': 'text/html; charset=utf-8' } });
            case '/api/rules':
                return Response.json(rules);
            case '/api/runs': {
                const runs = await loadRuns(root);
                return Response.json(runs.map((r) => {
                    const reviews = loadReviews(r.dir);
                    return {
                        key: r.key,
                        model: r.info.model,
                        scenario: r.info.scenario,
                        repeat: r.info.repeat,
                        error: r.result.error,
                        reviewedBy: reviews.map((v) => v.author),
                    };
                }));
            }
            case '/api/run': {
                const run = await runByKey(key);
                if (!run) return new Response('no such run', { status: 404 });
                return Response.json({
                    info: run.info,
                    result: run.result,
                    blocks: blocksOf(run.info, read(run, 'events.jsonl')),
                    diff: read(run, 'diff.patch'),
                    reviews: loadReviews(run.dir),
                });
            }
            case '/api/review': {
                if (request.method !== 'PUT') return new Response('PUT only', { status: 405 });
                const run = await runByKey(key);
                if (!run) return new Response('no such run', { status: 404 });
                const review = (await request.json()) as Review;
                saveReview(run.dir, { ...review, author: HUMAN, updatedAt: new Date().toISOString() });
                return new Response('saved');
            }
            case '/api/summary': {
                const text = summarise(await loadRuns(root));
                writeFileSync(join(root, 'review-summary.md'), text);
                return new Response(text, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
            }
            default:
                return new Response('not found', { status: 404 });
        }
    },
});

console.log(`reviewing ${root} on http://localhost:${server.port}`);
