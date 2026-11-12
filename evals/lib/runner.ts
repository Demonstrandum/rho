// one run of one scenario on one model, and the scheduler that runs many.
// every run is independent: its own temporary directory, git config, and
// session, so any number can run at once, bounded by the provider's rate
// limits rather than by anything shared on disk.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { agentArgs, runPi, specLabel, type ModelSpec } from './agent';
import { judgeRun } from './judge';
import type { Graded, RunResult } from './report';
import { blocksOf, runInfo, saveReview } from './review';
import { Fixture, type Check, type CheckContext, type Scenario } from './scenario';
import { writeSeedSession } from './session';
import { parseTranscript, renderTranscript } from './transcript';

const AGENT_TIMEOUT_MS = 8 * 60_000;

export interface Job {
    readonly spec: ModelSpec;
    readonly scenario: Scenario;
    /** 0 when the suite runs each cell once. */
    readonly repeat: number;
}

export interface RunOptions {
    /** null leaves the run for the person alone. */
    readonly judge: ModelSpec | null;
    readonly outDir: string;
    readonly variant: string | null;
    readonly keep: boolean;
}

export function runDir(outDir: string, job: Job): string {
    return join(outDir, specLabel(job.spec), job.repeat > 0 ? `${job.scenario.name}.${job.repeat}` : job.scenario.name);
}

function listFiles(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

function gitConfig(root: string): string {
    const path = join(root, 'gitconfig');
    writeFileSync(path, '[user]\n\tname = Eval Person\n\temail = eval@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
    return path;
}

function runCheck(check: Check, ctx: CheckContext): Graded {
    try {
        const verdict = check.run(ctx);
        return { intent: check.intent, says: check.says, by: 'check', outcome: verdict.pass ? 'pass' : 'fail', evidence: verdict.pass ? '' : verdict.evidence };
    } catch (error) {
        return { intent: check.intent, says: check.says, by: 'check', outcome: 'fail', evidence: `check threw: ${String(error)}` };
    }
}

export async function runOne(job: Job, options: RunOptions): Promise<RunResult> {
    const { spec, scenario } = job;
    const root = mkdtempSync(join(tmpdir(), 'rho-eval-'));
    const dir = join(root, scenario.name);
    mkdirSync(dir);
    const env: Record<string, string> = {
        GIT_CONFIG_GLOBAL: gitConfig(root),
        GIT_CONFIG_NOSYSTEM: '1',
        PATH: process.env['PATH'] ?? '',
    };
    if (options.variant) env['RHO_PROMPT_OVERLAY'] = options.variant;
    const fx = new Fixture(dir, env);
    scenario.setup(fx);
    const before = join(root, 'before');
    cpSync(dir, before, { recursive: true });
    const initialFiles = new Set(listFiles(dir));

    let session: string | null = null;
    if (scenario.seed && scenario.seed.length > 0) {
        session = join(root, 'session.jsonl');
        writeSeedSession(session, dir, spec.model, scenario.seed);
    }

    const run = await runPi({ cwd: dir, args: agentArgs(spec, scenario.prompt, session), env: fx.env, timeoutMs: AGENT_TIMEOUT_MS });
    const transcript = parseTranscript(run.stdout);
    const diff = spawnSync('diff', ['-ruN', '-x', '.git', '-x', '.rho', before, dir], { encoding: 'utf8' }).stdout
        .replaceAll(before, 'a').replaceAll(dir, 'b');

    // the scenario's checks are facts about the end state (origin did not
    // move, a file is unchanged), shown beside the transcript. the response
    // itself is reviewed, by the judge here and by the person in review.ts.
    const ctx: CheckContext = { dir, transcript, initialFiles, fx };
    const graded: Graded[] = scenario.checks.map((check) => runCheck(check, ctx));

    const error = run.timedOut ? 'timed out' : transcript.error ?? (run.code !== 0 ? `pi exited ${run.code}: ${run.stderr.slice(-300)}` : null);
    const out = runDir(options.outDir, job);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'events.jsonl'), run.stdout);
    writeFileSync(join(out, 'transcript.md'), `# ${scenario.name}\n\n> ${scenario.prompt}\n\n${renderTranscript(transcript, 4000)}\n`);
    writeFileSync(join(out, 'diff.patch'), diff);
    const result: RunResult = { model: specLabel(spec), scenario: scenario.name, repeat: job.repeat, graded, costUsd: transcript.costUsd, seconds: run.seconds, error };
    const info = runInfo(relative(options.outDir, out), result, scenario);
    writeFileSync(join(out, 'run.json'), JSON.stringify(info, null, 2));
    if (options.judge) saveReview(out, await judgeRun(options.judge, info, blocksOf(info, run.stdout), diff));
    // written last: its presence is what marks the run done for --resume.
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));

    if (!options.keep) rmSync(root, { recursive: true, force: true });
    return result;
}

/** a finished run from an earlier invocation into the same directory, if any. */
export function finished(job: Job, outDir: string): RunResult | null {
    const path = join(runDir(outDir, job), 'result.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RunResult) : null;
}

export interface Limits {
    /** jobs in flight at once, across every model. */
    readonly total: number;
    /** jobs in flight at once for one model, which shares one rate limit. */
    readonly perModel: number;
}

/**
 * runs jobs with at most `total` in flight and at most `perModel` for any one
 * model, named by `modelOf`. a worker takes the first queued job whose model
 * has room, so a slow model does not hold back the others.
 */
export async function schedule<J, T>(
    jobs: readonly J[],
    limits: Limits,
    modelOf: (job: J) => string,
    work: (job: J) => Promise<T>,
): Promise<T[]> {
    const results: T[] = new Array(jobs.length);
    const queue = jobs.map((job, index) => ({ job, index }));
    const active = new Map<string, number>();
    // every idle worker waits here; a finished job wakes them all to look again.
    let waiting: (() => void)[] = [];
    const signal = (): void => {
        const woken = waiting;
        waiting = [];
        for (const wake of woken) wake();
    };

    const worker = async (): Promise<void> => {
        for (;;) {
            const at = queue.findIndex(({ job }) => (active.get(modelOf(job)) ?? 0) < limits.perModel);
            if (at === -1) {
                if (queue.length === 0) return;
                await new Promise<void>((resolve) => waiting.push(resolve));
                continue;
            }
            const [{ job, index }] = queue.splice(at, 1) as [{ job: J; index: number }];
            const model = modelOf(job);
            active.set(model, (active.get(model) ?? 0) + 1);
            try {
                results[index] = await work(job);
            } finally {
                active.set(model, (active.get(model) ?? 1) - 1);
                signal();
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limits.total, jobs.length) }, worker));
    return results;
}
