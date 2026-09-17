/**
 * The loop every front end runs: open, react, replace, finish.
 *
 * Written once, here, and with no screen in it. A front end decides what a list
 * looks like and which key means `stop`; it does not decide what happens when
 * the owner answers an event with a new view, because that is the same in a
 * terminal, in a browser and in a test. Putting it in the terminal front end
 * would mean writing it again for the next one, and the two would drift on the
 * cases that are easy to get wrong: an event arriving while a reaction is in
 * flight, and a dismissal that races a `done`.
 */

import type { Line, Reaction, View, ViewComponent, ViewEvent } from './model';

/** What a front end learns after sending an event. */
export type Outcome<T> =
    | { readonly kind: 'view'; readonly view: View }
    | { readonly kind: 'done'; readonly result: T }
    | { readonly kind: 'unchanged' }
    | { readonly kind: 'suspended'; readonly view: View };

export class ViewSession<T> {
    private view: View | null = null;
    private finished = false;
    private answer: T | undefined;
    /** one reaction at a time: a second event during one is queued behind it. */
    private busy: Promise<unknown> = Promise.resolve();

    constructor(private readonly component: ViewComponent<T>) {}

    get current(): View | null {
        return this.view;
    }

    get done(): boolean {
        return this.finished;
    }

    get result(): T | undefined {
        return this.answer;
    }

    async open(): Promise<View> {
        this.view = await this.component.open();
        return this.view;
    }

    /**
     * The full form of one row, for a view that asked to show one.
     *
     * Through the session rather than off the component, so a front end never
     * holds the component itself: the preview of a row is as much the owner's
     * answer as a reaction is.
     */
    async previewOf(item: string): Promise<readonly Line[] | null> {
        const lines = await this.component.preview?.(item);
        return lines ?? null;
    }

    /**
     * Hand the owner one event and say what became of the view.
     *
     * A dismissal always finishes, whatever the owner says about it: the
     * surface is gone, and an owner that answered with a new view would be
     * asking for a window that has closed.
     */
    send(event: ViewEvent): Promise<Outcome<T>> {
        const run = this.busy.then(() => this.handle(event));
        this.busy = run.catch(() => undefined);
        return run;
    }

    private async handle(event: ViewEvent): Promise<Outcome<T>> {
        if (this.finished) return { kind: 'done', result: this.answer as T };
        const reaction: Reaction<T> = (await this.component.react?.(event)) ?? { kind: 'ignore' };
        if (event.kind === 'dismiss') {
            this.finished = true;
            this.answer = reaction.kind === 'done' ? reaction.result : this.component.onDismiss;
            return { kind: 'done', result: this.answer as T };
        }
        switch (reaction.kind) {
            case 'update':
                this.view = reaction.view;
                return { kind: 'view', view: reaction.view };
            case 'done':
                this.finished = true;
                this.answer = reaction.result;
                return { kind: 'done', result: reaction.result };
            case 'suspend':
                await reaction.run();
                // The owner may have changed what there is to show while the
                // surface was closed, so the view is asked for again rather
                // than restored from before.
                this.view = await this.component.open();
                return { kind: 'suspended', view: this.view };
            case 'ignore':
                return { kind: 'unchanged' };
        }
    }
}
