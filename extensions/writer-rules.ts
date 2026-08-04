// inject the writer rules (ASD-STE100 derived prose standard) into the system
// prompt. these govern how the model writes technical prose; the auditor skill
// checks finished text against the same rule numbers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const rulesPath = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'writer-rules.md');
const rules = readFileSync(rulesPath, 'utf8').trim();

export default function (pi: ExtensionAPI) {
    pi.on('before_agent_start', async (event) => {
        return { systemPrompt: `${event.systemPrompt}\n\n${rules}` };
    });
}
