// a render patch that survives /reload.
//
// a patch that replaces `render` on a prototype outlives the module that made
// it: /reload evaluates the extension again, and a second patch lands on top
// of the first, which still closes over the old module's state and config. so
// the wrapper is installed once per process, keyed by a global symbol, and all
// it does is call whatever painter is in a holder that is also global. each
// evaluation of the module puts its own painter in the holder, or takes it
// out, and the wrapper picks that up on the next frame.

interface Renders {
    render(width: number): string[];
}

export type Paint<C> = (component: C, lines: string[], width: number) => string[];

interface Holder<C> {
    paint?: Paint<C>;
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
    const holder = (store[holderKey] ??= {}) as Holder<C>;

    const owner = target as unknown as Keyed;
    if (owner[holderKey] !== true) {
        const original = target.render;
        const wrapped = function (this: C, width: number): string[] {
            const lines = original.call(this, width);
            const paint = holder.paint;
            return paint === undefined ? lines : paint(this, lines, width);
        };
        Object.defineProperty(target, 'render', { configurable: true, writable: true, value: wrapped });
        owner[holderKey] = true;
    }
    return {
        set(paint) {
            holder.paint = paint;
        },
    };
}
