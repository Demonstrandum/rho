// hold what a preview replaced, and put it back if the preview is abandoned.
//
// a preview shows something the reader has not chosen: a theme under the
// cursor, a model in a list. the value it replaced has to survive until either
// a choice is made or the list closes, and it has to be read once, at the
// first preview, rather than on every one: reading it again later would read a
// preview back and make that the thing restored.
//
// both routes into the theme picker need this, and they are not the only pair
// that will, so it is a type rather than a pair of flags in each of them.

export interface PreviewHold<T> {
    /** show `value`, remembering what was there on the first call. */
    preview(value: T): void;
    /** keep what is shown; there is nothing to go back to. */
    commit(): void;
    /** put back what the first preview replaced, if anything replaced it. */
    revert(): void;
    /** what would be restored, or undefined when nothing is held. */
    readonly held: T | undefined;
}

export interface HoldOptions<T> {
    /** the value in force now. */
    read(): T | undefined;
    /** put a value in force. false means it did not take, so nothing is held. */
    write(value: T): boolean;
}

export function previewHold<T>(options: HoldOptions<T>): PreviewHold<T> {
    let held: T | undefined;
    let holding = false;

    return {
        get held(): T | undefined {
            return holding ? held : undefined;
        },
        preview(value: T): void {
            const before = holding ? held : options.read();
            if (!options.write(value)) return;
            held = before;
            holding = true;
        },
        commit(): void {
            held = undefined;
            holding = false;
        },
        revert(): void {
            if (holding && held !== undefined) options.write(held);
            held = undefined;
            holding = false;
        },
    };
}
