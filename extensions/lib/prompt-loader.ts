// reads the master template (system/prompt.md), resolves includes,
// evaluates conditionals and expressions, caches the result.
//
// processes line by line:
//   {{include:file.md}}      inline a file
//   {{#if expr}}...{{/if}}   conditional block (nestable)
//   {{else}}                 else branch
//   {{expression}}           JS evaluated via new Function()
//
// if variables contain SourceStr values, the output carries embedded
// markers; call stripMarkers() for a clean prompt, or parseSpans()
// line by line for the explorer view.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripMarkers } from './source-str';

export class PromptLoader {
    private readonly dir: string;
    private readonly entry: string;
    private cached: string | null = null;

    constructor(dir: string, entry = 'prompt.md') {
        this.dir = dir;
        this.entry = entry;
    }

    resolve(variables?: Record<string, unknown>, opts?: { strip?: boolean }): string {
        if (this.cached !== null) return this.cached;

        let text = readFileSync(join(this.dir, this.entry), 'utf8');

        // 1. resolve {{include:file}} directives (one level deep).
        text = text.replace(
            /\{\{include:([^}]+)\}\}/g,
            (_, file: string) => readFileSync(join(this.dir, file.trim()), 'utf8').trim(),
        );

        // 2. line-by-line: conditionals + expressions in one pass.
        if (variables) {
            const keys = Object.keys(variables);
            const vals = Object.values(variables);
            const out: string[] = [];
            const cond: boolean[] = [];

            for (const line of text.split('\n')) {
                const ifM = line.match(/^\s*\{\{#if\s+(.+)\}\}\s*$/);
                if (ifM) {
                    try {
                        const fn = new Function(...keys, `return !!(${ifM[1]})`);
                        cond.push(fn(...vals));
                    } catch { cond.push(false); }
                    continue;
                }
                if (/^\s*\{\{else\}\}\s*$/.test(line)) {
                    if (cond.length > 0) cond[cond.length - 1] = !cond[cond.length - 1];
                    continue;
                }
                if (/^\s*\{\{\/if\}\}\s*$/.test(line)) {
                    cond.pop();
                    continue;
                }
                if (cond.length > 0 && !cond.every(Boolean)) continue;

                // evaluate {{expr}} in this line
                const processed = line.replace(/\{\{(.+?)\}\}/g, (_, expr: string) => {
                    try {
                        const fn = new Function(...keys, `return ${expr}`);
                        const result = fn(...vals);
                        return String(result ?? '');
                    } catch (e) {
                        return `{{ERROR: ${(e as Error).message}}}`;
                    }
                });
                out.push(processed);
            }
            text = out.join('\n');
        }

        // 3. strip SourceStr markers unless caller wants them.
        if (opts?.strip !== false) {
            text = stripMarkers(text);
        }

        // 4. collapse 3+ blank lines to 2; trim.
        text = text.replace(/\n{3,}/g, '\n\n').trim();

        this.cached = text;
        return this.cached;
    }
}
