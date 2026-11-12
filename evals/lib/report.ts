// the report, built from whatever result.json files a results directory holds,
// so shards run in separate processes or on separate machines merge by
// copying their directories together and running `bun evals/run.ts --report`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { INTENT_NAMES, INTENTS, type Fragment, type Intent } from './intents';
import type { Scenario } from './scenario';

export type Outcome = 'pass' | 'fail' | 'n/a';

export interface Graded {
    readonly intent: Intent;
    readonly says: string;
    readonly by: 'check' | 'judge';
    readonly outcome: Outcome;
    readonly evidence: string;
}

export interface RunResult {
    readonly model: string;
    readonly scenario: string;
    readonly repeat: number;
    readonly graded: Graded[];
    readonly costUsd: number;
    readonly seconds: number;
    readonly error: string | null;
}

export function loadResults(dir: string): RunResult[] {
    const out: RunResult[] = [];
    const walk = (path: string): void => {
        for (const name of readdirSync(path)) {
            const child = join(path, name);
            if (statSync(child).isDirectory()) walk(child);
            else if (name === 'result.json') out.push(JSON.parse(readFileSync(child, 'utf8')) as RunResult);
        }
    };
    walk(dir);
    return out;
}

function score(graded: readonly Graded[]): string {
    const counted = graded.filter((g) => g.outcome !== 'n/a');
    const passed = counted.filter((g) => g.outcome === 'pass').length;
    return counted.length === 0 ? '-' : `${passed}/${counted.length}`;
}

const short = (model: string): string => model.replace(/^claude-/, '').replace(/:medium$/, '');

export function buildReport(results: readonly RunResult[], header: string): string {
    const models = [...new Set(results.map((r) => r.model))];
    const scenarios = [...new Set(results.map((r) => r.scenario))].sort();
    const rows: string[] = [header, ''];
    const table = (title: string, keys: readonly string[], pick: (r: RunResult, key: string) => Graded[]): void => {
        rows.push(`## ${title}`, '', `| | ${models.map(short).join(' | ')} |`, `|---|${models.map(() => '---').join('|')}|`);
        for (const key of keys) {
            const cells = models.map((m) => score(results.filter((r) => r.model === m).flatMap((r) => pick(r, key))));
            rows.push(`| ${key} | ${cells.join(' | ')} |`);
        }
        rows.push('');
    };
    table('total', ['all'], (r) => r.graded);
    const intents = INTENT_NAMES.filter((i) => results.some((r) => r.graded.some((g) => g.intent === i)));
    table('by intent', intents, (r, key) => r.graded.filter((g) => g.intent === key));
    table('by scenario', scenarios, (r, key) => (r.scenario === key ? r.graded : []));

    rows.push('## cost', '', '| model | runs | usd | seconds | errors |', '|---|---|---|---|---|');
    for (const m of models) {
        const mine = results.filter((r) => r.model === m);
        const usd = mine.reduce((sum, r) => sum + r.costUsd, 0);
        const secs = mine.reduce((sum, r) => sum + r.seconds, 0);
        rows.push(`| ${short(m)} | ${mine.length} | ${usd.toFixed(2)} | ${secs.toFixed(0)} | ${mine.filter((r) => r.error).length} |`);
    }
    rows.push('', '## failures', '');
    for (const r of [...results].sort((a, b) => a.model.localeCompare(b.model) || a.scenario.localeCompare(b.scenario))) {
        const failed = r.graded.filter((g) => g.outcome === 'fail');
        if (failed.length === 0 && !r.error) continue;
        rows.push(`### ${short(r.model)} / ${r.scenario}${r.repeat > 0 ? ` #${r.repeat}` : ''}`, '');
        if (r.error) rows.push(`- run error: ${r.error}`);
        for (const g of failed) {
            rows.push(`- [${g.intent}, ${g.by}] ${g.says}`);
            if (g.evidence) rows.push(`  - ${g.evidence.replace(/\n/g, ' ').slice(0, 400)}`);
        }
        rows.push('');
    }
    return rows.join('\n');
}

/**
 * which intents the scenarios observe, against how much of the prompt each
 * fragment is, so a fragment that is a third of the prompt and a tenth of
 * the grades shows up as such.
 */
export function coverage(scenarios: readonly Scenario[], prose: readonly Intent[], fragmentBytes: Readonly<Record<Fragment, number>>): string {
    const observed = new Map<Intent, string[]>();
    const note = (intent: Intent, name: string): void => {
        const list = observed.get(intent) ?? [];
        if (!list.includes(name)) list.push(name);
        observed.set(intent, list);
    };
    for (const s of scenarios) {
        for (const c of s.checks) note(c.intent, s.name);
        for (const c of s.criteria) note(c.intent, s.name);
        for (const i of prose) note(i, '(every reply)');
    }
    const rows = ['| fragment | section | intent | observed by |', '|---|---|---|---|'];
    for (const name of INTENT_NAMES) {
        const source = INTENTS[name];
        rows.push(`| ${source.fragment ?? '-'} | ${source.section} | ${name} | ${(observed.get(name) ?? ['NONE']).join(', ')} |`);
    }
    const total = Object.values(fragmentBytes).reduce((a, b) => a + b, 0);
    const graded = (fragment: Fragment): number =>
        scenarios.reduce((n, s) => n + [...s.checks, ...s.criteria].filter((c) => INTENTS[c.intent].fragment === fragment).length, 0);
    const allGraded = scenarios.reduce((n, s) => n + s.checks.length + s.criteria.length, 0);
    rows.push('', '| fragment | share of prompt | share of scenario-specific grades |', '|---|---|---|');
    for (const [fragment, bytes] of Object.entries(fragmentBytes) as [Fragment, number][]) {
        rows.push(`| ${fragment} | ${Math.round((100 * bytes) / total)}% | ${Math.round((100 * graded(fragment)) / allGraded)}% |`);
    }
    return rows.join('\n');
}
