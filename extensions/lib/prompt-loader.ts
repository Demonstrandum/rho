// reads the master template (system/prompt.md), resolves {{include:file.md}}
// directives, evaluates {{expression}} with provided variables, and caches.
// the cache lives on the instance; /reload creates a fresh module scope
// (and therefore a fresh instance), so edits to any fragment are picked up.
//
// expressions are JS evaluated via new Function(). they have access to all
// keys in the variables object. if variables contain SourceStr values, the
// output carries embedded markers; call stripMarkers() on the result for
// a clean prompt, or parseSpans() line by line for the explorer view.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripMarkers } from './source-str';

// match {{...}} but not {{include:...}}. uses negative lookahead for
// 'include:' and a non-greedy body that stops at the first `}}`.
const EXPR_RE = /\{\{(?!include:)((?:(?!\}\}).)*?)\}\}/gs;

export class PromptLoader {
    private readonly dir: string;
    private readonly entry: string;
    private cached: string | null = null;

    constructor(dir: string, entry = 'prompt.md') {
        this.dir = dir;
        this.entry = entry;
    }

    // resolve the template. pass strip: false to keep SourceStr markers
    // in the output (for the explorer). default strips them.
    resolve(variables?: Record<string, unknown>, opts?: { strip?: boolean }): string {
        if (this.cached !== null) return this.cached;

        let text = readFileSync(join(this.dir, this.entry), 'utf8');

        // 1. resolve {{include:filename.md}} directives (one level deep).
        text = text.replace(
            /\{\{include:([^}]+)\}\}/g,
            (_, file: string) => readFileSync(join(this.dir, file.trim()), 'utf8').trim(),
        );

        // 2. evaluate {{expression}} with provided variables.
        if (variables) {
            const keys = Object.keys(variables);
            const vals = Object.values(variables);
            text = text.replace(EXPR_RE, (_, expr: string) => {
                try {
                    const fn = new Function(...keys, `return ${expr}`);
                    const result = fn(...vals);
                    return String(result ?? '');
                } catch (e) {
                    return `{{ERROR: ${(e as Error).message}}}`;
                }
            });
        }

        // 3. strip SourceStr markers unless caller wants them.
        if (opts?.strip !== false) {
            text = stripMarkers(text);
        }

        // 4. collapse runs of 3+ blank lines to 2; trim.
        text = text.replace(/\n{3,}/g, '\n\n').trim();

        this.cached = text;
        return this.cached;
    }
}
