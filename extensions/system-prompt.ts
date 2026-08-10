// single extension that assembles and injects the system prompt from
// system/prompt.md. reads the master template, resolves includes,
// fills vocabulary variables, caches the result.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PromptLoader } from './lib/prompt-loader';
import { wordEntries, patternEntries } from './wordswap';

const systemDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'system');

const loader = new PromptLoader(systemDir);
const prompt = loader.resolve({ words: wordEntries, patterns: patternEntries });

export default function (pi: ExtensionAPI) {
    pi.on('before_agent_start', async (event) => {
        return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
    });
}
