// a render patch that survives /reload.
//
// a patch that replaces `render` on a prototype outlives the module that made
// it: /reload evaluates the extension again, and a second patch lands on top
// of the first, which still closes over the old module's state and config. so
// the wrapper is installed once per process, keyed by a global symbol, and all
// it does is call whatever painter is in a holder that is also global. each
// evaluation of the module puts its own painter in the holder, or takes it
// out, and the wrapper picks that up on the next frame.
//
// "installed" is decided by looking at the `render` that is there now, not by
// a flag on the target: input-field.ts assigns CustomEditor.prototype.render
// outright each time it loads, which discards a wrapper while a flag on the
// prototype would still say it was in place.
//
// that check cannot see a wrapper of ours under someone else's (halfblock-boxes
// wraps the tool row's render again on every load), so a second one can be
// installed above the first. the painter therefore runs only in the outermost
// wrapper of a render, counted per holder.

interface Renders {
    render(width: number): string[];
}

export type Paint<C> = (component: C, lines: string[], width: number) => string[];

interface Holder<C> {
    paint?: Paint<C>;
    depth: number;
}

type Keyed = { [key: symbol]: unknown };

/**
 * the relay named `name` on `target` (a prototype, or one instance), installed
 * if it is not there yet. `set` replaces the painter; undefined leaves the
 * lines as the original render made them.
 */
export function relay<C extends Renders>(target: C, name: string): { set(paint: Paint<C> | undefined): void } {
    const holderKey = Symbol.for(`rho.render-relay.${name}`);
    const store = globalThis as unknown as Keyed;
    const holder = (store[holderKey] ??= { depth: 0 }) as Holder<C>;

    const current = target.render as unknown as Keyed;
    if (current[holderKey] !== true) {
        const original = target.render;
        const wrapped = function (this: C, width: number): string[] {
            holder.depth++;
            let lines: string[];
            try {
                lines = original.call(this, width);
            } finally {
                holder.depth--;
            }
            const paint = holder.paint;
            return paint === undefined || holder.depth > 0 ? lines : paint(this, lines, width);
        };
        (wrapped as unknown as Keyed)[holderKey] = true;
        Object.defineProperty(target, 'render', { configurable: true, writable: true, value: wrapped });
    }
    return {
        set(paint) {
            holder.paint = paint;
        },
    };
}
