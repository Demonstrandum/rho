// shared {{...}} template evaluator.
//
// standard namespace (`builtins`) is always available inside expressions.
// callers can pass additional variables that layer on top.
//
// usage:
//   import { evalTemplates, builtins } from './template';
//   evalTemplates('rolled a {{randint(1, 6)}}')        // builtins only
//   evalTemplates('hello {{name}}', { name: 'world' }) // extra vars

export const builtins = {
    /** random integer in [min, max] inclusive */
    randint: (min: number, max: number) =>
        min + Math.floor(Math.random() * (max - min + 1)),

    /** random float in [min, max), rounded to `decimals` places (default 2) */
    randfloat: (min: number, max: number, decimals = 2) => {
        const v = min + Math.random() * (max - min);
        return Number(v.toFixed(decimals));
    },

    /** pick one element from an array at random */
    pick: <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)],
};

const EXPR_RE = /\{\{(.+?)\}\}/g;

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

    return text.replace(EXPR_RE, (_, expr: string) => {
        try {
            const fn = new Function(...allKeys, `return ${expr}`);
            return String(fn(...allVals));
        } catch {
            return expr;
        }
    });
}
