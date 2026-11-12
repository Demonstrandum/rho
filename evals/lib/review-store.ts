// the runs of one results directory, as the review UI and the summary see
// them. a run is a directory holding result.json; run.json says what it was
// asked, and for runs written before run.json existed it is rebuilt from the
// scenario module of the same name.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RunResult } from './report';
import { DIMENSIONS, HUMAN, loadReviews, runInfo, type Dimension, type Review, type RunInfo } from './review';
import type { Scenario } from './scenario';

export interface StoredRun {
    readonly key: string;
    readonly dir: string;
    readonly result: RunResult;
    readonly info: RunInfo;
}

const scenarioCache = new Map<string, Scenario | null>();

async function scenarioNamed(name: string): Promise<Scenario | null> {
    if (!scenarioCache.has(name)) {
        const path = join(import.meta.dir, '..', 'scenarios', `${name}.ts`);
        scenarioCache.set(name, existsSync(path) ? ((await import(path)) as { default: Scenario }).default : null);
    }
    return scenarioCache.get(name) ?? null;
}

export async function loadRuns(root: string): Promise<StoredRun[]> {
    const runs: StoredRun[] = [];
    const walk = async (dir: string): Promise<void> => {
        if (existsSync(join(dir, 'result.json'))) {
            const key = relative(root, dir);
            const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as RunResult;
            let info: RunInfo | null = null;
            if (existsSync(join(dir, 'run.json'))) {
                info = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunInfo;
            } else {
                const scenario = await scenarioNamed(result.scenario);
                if (scenario) info = runInfo(key, result, scenario);
            }
            if (info) runs.push({ key, dir, result, info });
            return;
        }
        for (const name of readdirSync(dir)) {
            const child = join(dir, name);
            if (name !== 'reviews' && statSync(child).isDirectory()) await walk(child);
        }
    };
    await walk(root);
    return runs.sort((a, b) => a.info.scenario.localeCompare(b.info.scenario) || a.info.model.localeCompare(b.info.model) || a.info.repeat - b.info.repeat);
}

const short = (model: string): string => model.replace(/^claude-/, '').replace(/:medium$/, '');

function mean(values: readonly number[]): string {
    return values.length === 0 ? '-' : (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
}

/**
 * what the reviews say, per model. a finding counts as confirmed when the
 * person wrote it, or when the judge wrote it and the person agreed; judge
 * findings the person has not answered are counted apart, and disagreed ones
 * are what the judge's agreement rate is made of.
 */
export function summarise(runs: readonly StoredRun[]): string {
    const models = [...new Set(runs.map((r) => r.info.model))];
    const reviewsOf = new Map(runs.map((r) => [r.key, loadReviews(r.dir)] as const));
    const human = (r: StoredRun): Review | undefined => reviewsOf.get(r.key)?.find((v) => v.author === HUMAN);
    const judges = (r: StoredRun): Review[] => reviewsOf.get(r.key)?.filter((v) => v.author !== HUMAN) ?? [];

    const out: string[] = ['# review summary', ''];
    const reviewed = runs.filter((r) => human(r));
    out.push(`${reviewed.length} of ${runs.length} runs reviewed by the person; ${runs.filter((r) => judges(r).length > 0).length} by a judge.`, '');

    out.push('## ratings, person (judge)', '', `| | ${models.map(short).join(' | ')} |`, `|---|${models.map(() => '---').join('|')}|`);
    for (const d of DIMENSIONS) {
        const cells = models.map((m) => {
            const mine = runs.filter((r) => r.info.model === m);
            const h = mine.flatMap((r) => (human(r)?.ratings[d] !== undefined ? [human(r)!.ratings[d]!] : []));
            const j = mine.flatMap((r) => judges(r).flatMap((v) => (v.ratings[d as Dimension] !== undefined ? [v.ratings[d as Dimension]!] : [])));
            return `${mean(h)} (${mean(j)})`;
        });
        out.push(`| ${d} | ${cells.join(' | ')} |`);
    }

    type Tally = { confirmed: number; open: number; rejected: number };
    const byRule = new Map<string, Map<string, Tally>>();
    let agreed = 0;
    let disagreed = 0;
    for (const r of runs) {
        const person = human(r);
        const bump = (rule: string, field: keyof Tally): void => {
            const row = byRule.get(rule) ?? new Map<string, Tally>();
            const tally = row.get(r.info.model) ?? { confirmed: 0, open: 0, rejected: 0 };
            tally[field]++;
            row.set(r.info.model, tally);
            byRule.set(rule, row);
        };
        for (const a of person?.annotations ?? []) bump(a.rule ?? '(no rule)', 'confirmed');
        for (const j of judges(r)) {
            for (const a of j.annotations) {
                const answer = person?.responses[a.id];
                if (answer === 'agree') agreed++;
                if (answer === 'disagree') disagreed++;
                bump(a.rule ?? '(no rule)', answer === 'agree' ? 'confirmed' : answer === 'disagree' ? 'rejected' : 'open');
            }
        }
    }
    out.push('', '## findings by rule', '', 'confirmed / unanswered judge findings; rejected judge findings are left out.', '');
    out.push(`| rule | ${models.map(short).join(' | ')} |`, `|---|${models.map(() => '---').join('|')}|`);
    const total = (row: Map<string, Tally>): number => [...row.values()].reduce((n, t) => n + t.confirmed + t.open, 0);
    for (const [rule, row] of [...byRule.entries()].sort((a, b) => total(b[1]) - total(a[1]))) {
        if (total(row) === 0) continue;
        out.push(`| ${rule} | ${models.map((m) => { const t = row.get(m); return t ? `${t.confirmed} / ${t.open}` : ''; }).join(' | ')} |`);
    }
    const answered = agreed + disagreed;
    out.push('', `judge agreement: ${answered === 0 ? 'no judge findings answered yet' : `${agreed} of ${answered} answered findings (${Math.round((100 * agreed) / answered)}%)`}.`);

    const analyses = reviewed.filter((r) => human(r)!.analysis.trim() !== '');
    if (analyses.length > 0) {
        out.push('', '## analyses', '');
        for (const r of analyses) out.push(`### ${short(r.info.model)} / ${r.info.scenario}${r.info.repeat ? ` #${r.info.repeat}` : ''}`, '', human(r)!.analysis.trim(), '');
    }
    return out.join('\n');
}
