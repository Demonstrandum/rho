// shared {{...}} template evaluator.
//
// standard namespace (`builtins`) is always available inside expressions.
// callers can pass additional variables that layer on top.
//
// usage:
//   import { evalTemplates, builtins } from './template';
//   evalTemplates('rolled a {{randint(1, 6)}}')        // builtins only
//   evalTemplates('hello {{name}}', { name: 'world' }) // extra vars

import { randint, randfloat, pick } from './utils';

export const builtins: Record<string, unknown> = { randint, randfloat, pick };

// match a whole line that is just {{expr}}, or inline {{expr}} without
// nested }}. for lines where the expression contains }, the line must
// be ONLY the expression (no surrounding text).
function evalExprInLine(line: string, keys: string[], vals: unknown[]): string {
    // whole-line expression: {{...}} is the entire line (modulo whitespace)
    const wholeLine = line.match(/^(\s*)\{\{(.+)\}\}(\s*)$/);
    if (wholeLine) {
        try {
            const fn = new Function(...keys, `return ${wholeLine[2]}`);
            return wholeLine[1] + String(fn(...vals)) + wholeLine[3];
        } catch {
            return line;
        }
    }
    // inline: safe non-greedy match (no } inside the expression)
    return line.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
        try {
            const fn = new Function(...keys, `return ${expr}`);
            return String(fn(...vals));
        } catch {
            return expr;
        }
    });
}

/**
 * evaluate all `{{expr}}` spans in `text`.
 *
 * every expression has access to `builtins` (randint, randfloat, pick)
 * plus any keys in `vars`. on eval error the raw expression is left in place.
 */
export function evalTemplates(text: string, vars?: Record<string, unknown>): string {
    const allKeys = Object.keys(builtins);
    const allVals: unknown[] = Object.values(builtins);

    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            allKeys.push(k);
            allVals.push(v);
        }
    }

    return text.split('\n').map(line => evalExprInLine(line, allKeys, allVals)).join('\n');
}
