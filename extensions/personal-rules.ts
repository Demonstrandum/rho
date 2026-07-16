import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const rulesPath = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'personal-rules.md');
// read once at load; before_agent_start fires every turn, and /reload re-runs
// module init to pick up edits to the markdown.
const rules = readFileSync(rulesPath, 'utf8').trim();

export default function (pi: ExtensionAPI) {
    pi.on('before_agent_start', async (event) => {
        return { systemPrompt: `${event.systemPrompt}\n\n${rules}` };
    });
}
