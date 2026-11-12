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
//
// the directory may be a search path. each file, the entry included, is read
// from the first directory that has it, so an overlay directory holding one
// changed fragment is a whole prompt variant (evals/ uses this).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripMarkers } from '../core/source-str';
import { evalTemplates } from '../core/template';

export class PromptLoader {
    private readonly dirs: readonly string[];
    private readonly entry: string;
    private cached: string | null = null;

    constructor(dirs: string | readonly string[], entry = 'prompt.md') {
        this.dirs = typeof dirs === 'string' ? [dirs] : dirs;
        this.entry = entry;
    }

    private read(file: string): string {
        const found = this.dirs.map((dir) => join(dir, file)).find((path) => existsSync(path));
        if (found === undefined) throw new Error(`prompt file ${file} is in none of ${this.dirs.join(', ')}`);
        return readFileSync(found, 'utf8');
    }

    resolve(variables?: Record<string, unknown>, opts?: { strip?: boolean }): string {
        if (this.cached !== null) return this.cached;

        let text = this.read(this.entry);

        // 1. resolve {{include:file}} directives (one level deep).
        text = text.replace(
            /\{\{include:([^}]+)\}\}/g,
            (_, file: string) => this.read(file.trim()).trim(),
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
                const processed = evalTemplates(line, variables);
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
