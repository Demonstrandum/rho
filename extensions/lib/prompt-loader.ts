// reads the master template (system/prompt.md), resolves {{include:file.md}}
// directives, fills {{VARIABLE}} placeholders, and caches the result.
// the cache lives on the instance; /reload creates a fresh module scope
// (and therefore a fresh instance), so edits to any fragment are picked up.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class PromptLoader {
    private readonly dir: string;
    private readonly entry: string;
    private cached: string | null = null;

    constructor(dir: string, entry = 'prompt.md') {
        this.dir = dir;
        this.entry = entry;
    }

    resolve(variables?: Record<string, string>): string {
        if (this.cached !== null) return this.cached;

        let text = readFileSync(join(this.dir, this.entry), 'utf8');

        // resolve {{include:filename.md}} directives (one level deep).
        text = text.replace(
            /\{\{include:([^}]+)\}\}/g,
            (_, file: string) => readFileSync(join(this.dir, file.trim()), 'utf8').trim(),
        );

        // fill {{VARIABLE}} placeholders.
        if (variables) {
            for (const [key, value] of Object.entries(variables)) {
                text = text.replaceAll(`{{${key}}}`, value);
            }
        }

        // collapse runs of 3+ blank lines to 2; trim.
        text = text.replace(/\n{3,}/g, '\n\n').trim();

        this.cached = text;
        return this.cached;
    }
}
