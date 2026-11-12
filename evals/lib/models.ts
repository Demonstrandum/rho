// the models the suite is run against by default, and a check that pi knows
// each of them before any run starts, so a typo or a model that does not exist
// fails in a second rather than as eleven empty transcripts.
import { spawnSync } from 'node:child_process';
import { parseModelSpec, type ModelSpec, type ThinkingLevel } from './agent';

export type Family = 'opus' | 'sonnet' | 'fable' | 'haiku';

interface MatrixEntry {
    readonly family: Family;
    readonly id: string;
}

export const MATRIX: readonly MatrixEntry[] = [
    { family: 'opus', id: 'claude-opus-5-5' },
    { family: 'opus', id: 'claude-opus-5' },
    { family: 'opus', id: 'claude-opus-4-8' },
    { family: 'opus', id: 'claude-opus-4-5' },
    { family: 'sonnet', id: 'claude-sonnet-5-5' },
    { family: 'sonnet', id: 'claude-sonnet-5' },
    { family: 'sonnet', id: 'claude-sonnet-4-6' },
    { family: 'sonnet', id: 'claude-sonnet-4-5' },
    { family: 'fable', id: 'claude-fable-5-1' },
    { family: 'fable', id: 'claude-fable-5' },
    { family: 'haiku', id: 'claude-haiku-5-5' },
    { family: 'haiku', id: 'claude-haiku-4-5' },
];

export function matrixSpecs(thinking: ThinkingLevel): ModelSpec[] {
    return MATRIX.map((entry) => ({ model: `anthropic/${entry.id}`, thinking }));
}

export function parseModels(list: string, thinking: ThinkingLevel): ModelSpec[] {
    return list.split(',').map((m) => m.trim()).filter(Boolean).map((m) => parseModelSpec(m, thinking));
}

/** the models pi does not list; empty when every spec is runnable. */
export function unknownModels(specs: readonly ModelSpec[]): string[] {
    const listed = spawnSync('pi', ['--list-models'], { encoding: 'utf8', timeout: 60_000 }).stdout ?? '';
    const known = new Set(listed.split('\n').slice(1).map((line) => {
        const [provider, id] = line.trim().split(/\s+/);
        return `${provider}/${id}`;
    }));
    return specs.map((s) => s.model).filter((m) => !known.has(m));
}
