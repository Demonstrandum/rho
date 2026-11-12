// a review of one run: ratings, a written analysis, and annotations, each
// annotation optionally pinned to a span of the transcript and to a rule.
// a person and a judge model write reviews in the same shape; the person can
// also answer each judge annotation with agree or disagree, which is what
// makes a judge finding count.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from './report';
import type { Scenario, SeedTurn } from './scenario';
import { parseTranscript } from './transcript';

export const DIMENSIONS = ['task', 'judgement', 'code', 'prose', 'format'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_DESCRIPTIONS: Readonly<Record<Dimension, string>> = {
    task: "did the work asked for, and what it claims is true",
    judgement: "risky actions, asking before acting, other people's work left alone",
    code: "types, data structures, conventions, comments, in what it wrote",
    prose: "the writer rules: assertions, rhetoric, register, endings, vocabulary",
    format: "orthography and prose style: characters, spelling, numbers, lines, lists",
};

export type Score = 1 | 2 | 3 | 4 | 5;
export type Severity = 'note' | 'minor' | 'major';
export type Response = 'agree' | 'disagree';

export type BlockKind = 'earlier-user' | 'earlier-assistant' | 'user' | 'assistant' | 'tool-call' | 'tool-result';

export interface Block {
    readonly kind: BlockKind;
    readonly text: string;
    /** the tool's name, for tool-call and tool-result blocks. */
    readonly tool?: string;
}

export interface Span {
    readonly block: number;
    readonly start: number;
    readonly end: number;
    readonly quote: string;
}

export interface Annotation {
    readonly id: string;
    /** null for a remark on the run as a whole. */
    readonly span: Span | null;
    readonly rule: string | null;
    readonly severity: Severity;
    readonly note: string;
}

export interface Review {
    readonly author: string;
    readonly ratings: Partial<Record<Dimension, Score>>;
    readonly analysis: string;
    readonly annotations: readonly Annotation[];
    /** the person's answer to another author's annotation, by annotation id. */
    readonly responses: Readonly<Record<string, Response>>;
    readonly updatedAt: string;
}

/** what a run was asked, written beside its result so a review needs no scenario module. */
export interface RunInfo {
    readonly key: string;
    readonly model: string;
    readonly scenario: string;
    readonly repeat: number;
    readonly context: string;
    readonly seed: readonly SeedTurn[];
    readonly prompt: string;
    readonly focus: readonly string[];
}

export const HUMAN = 'human';

export function runInfo(key: string, result: RunResult, scenario: Scenario): RunInfo {
    return {
        key,
        model: result.model,
        scenario: scenario.name,
        repeat: result.repeat,
        context: scenario.context,
        seed: scenario.seed ?? [],
        prompt: scenario.prompt,
        focus: scenario.criteria.map((c) => c.says),
    };
}

export function blocksOf(info: RunInfo, eventsJsonl: string): Block[] {
    const blocks: Block[] = [];
    for (const turn of info.seed) {
        blocks.push({ kind: 'earlier-user', text: turn.user }, { kind: 'earlier-assistant', text: turn.assistant });
    }
    blocks.push({ kind: 'user', text: info.prompt });
    for (const turn of parseTranscript(eventsJsonl).turns) {
        for (const text of turn.texts) if (text.trim() !== '') blocks.push({ kind: 'assistant', text });
        for (const use of turn.tools) {
            const args = typeof use.args['command'] === 'string' && Object.keys(use.args).length <= 3
                ? String(use.args['command'])
                : JSON.stringify(use.args, null, 2);
            blocks.push({ kind: 'tool-call', tool: use.name, text: args });
            blocks.push({ kind: 'tool-result', tool: use.name, text: use.result });
        }
    }
    return blocks;
}

/**
 * pins a quoted passage to the block holding it. the judge returns quotes,
 * not offsets; an exact match is tried first, then one with whitespace runs
 * collapsed. assistant blocks are searched before tool blocks.
 */
export function locate(blocks: readonly Block[], quote: string): Span | null {
    const order = blocks.map((b, i) => ({ b, i })).sort((x, y) => Number(y.b.kind === 'assistant') - Number(x.b.kind === 'assistant'));
    for (const { b, i } of order) {
        const at = b.text.indexOf(quote);
        if (at !== -1) return { block: i, start: at, end: at + quote.length, quote };
    }
    const squash = (s: string): string => s.replace(/\s+/g, ' ');
    const target = squash(quote).trim();
    if (target === '') return null;
    for (const { b, i } of order) {
        const flat = squash(b.text);
        const at = flat.indexOf(target);
        if (at === -1) continue;
        // map the collapsed offset back onto the original text.
        let raw = 0;
        let seen = 0;
        while (seen < at && raw < b.text.length) {
            if (/\s/.test(b.text[raw]!)) {
                while (raw + 1 < b.text.length && /\s/.test(b.text[raw + 1]!)) raw++;
            }
            raw++;
            seen++;
        }
        let end = raw;
        let taken = 0;
        while (taken < target.length && end < b.text.length) {
            if (/\s/.test(b.text[end]!)) {
                while (end + 1 < b.text.length && /\s/.test(b.text[end + 1]!)) end++;
            }
            end++;
            taken++;
        }
        return { block: i, start: raw, end, quote: b.text.slice(raw, end) };
    }
    return null;
}

const reviewsDir = (runDir: string): string => join(runDir, 'reviews');
const fileFor = (author: string): string => `${author.replace(/[^a-z0-9.-]+/gi, '_')}.json`;

export function loadReviews(runDir: string): Review[] {
    const dir = reviewsDir(runDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Review);
}

export function saveReview(runDir: string, review: Review): void {
    mkdirSync(reviewsDir(runDir), { recursive: true });
    writeFileSync(join(reviewsDir(runDir), fileFor(review.author)), JSON.stringify(review, null, 2));
}
