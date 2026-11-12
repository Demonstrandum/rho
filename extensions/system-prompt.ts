// single extension that assembles and injects the system prompt from
// system/prompt.md. reads the master template, resolves includes,
// fills vocabulary variables, caches the result per model.
//
// the template sees `model` ({ provider, id }), so guidance one model needs
// and another does not sits in an {{#if}} block rather than in every prompt.
// RHO_PROMPT_OVERLAY names a directory searched before system/, which is how
// evals/ runs a prompt variant without touching the live one.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PromptLoader } from './lib/prose/prompt-loader';
import { wordEntries, patternEntries } from './wordswap';

const systemDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'system');

export interface PromptModel {
    readonly provider: string;
    readonly id: string;
}

const NO_MODEL: PromptModel = { provider: '', id: '' };

export function promptDirs(overlay: string | undefined = process.env['RHO_PROMPT_OVERLAY']): readonly string[] {
    return overlay ? [overlay, systemDir] : [systemDir];
}

export function resolvePrompt(model: PromptModel, dirs: readonly string[] = promptDirs()): string {
    return new PromptLoader(dirs).resolve({ words: wordEntries, patterns: patternEntries, model });
}

const byModel = new Map<string, string>();

function promptFor(model: PromptModel): string {
    const key = `${model.provider}/${model.id}`;
    let prompt = byModel.get(key);
    if (prompt === undefined) {
        prompt = resolvePrompt(model);
        byModel.set(key, prompt);
    }
    return prompt;
}

export default function (pi: ExtensionAPI) {
    pi.on('before_agent_start', async (event, ctx) => {
        const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : NO_MODEL;
        return { systemPrompt: `${event.systemPrompt}\n\n${promptFor(model)}` };
    });
}
