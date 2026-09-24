/**
 * A short list of named outcomes, picked by arrow keys or by one letter.
 *
 * `ctx.ui.select` takes plain strings, so a menu built on it has one column
 * and no keys of its own: the only way to answer is to walk the list. That is
 * the right shape for a question asked once, and the wrong one for a question
 * asked every time an interface is closed, where the answer is known before
 * the menu appears and pressing its first letter should be the whole
 * interaction.
 *
 * The letter is not configured separately from the tag. A tag is typed as a
 * string whose first character is a letter, and that character is the key, so
 * a menu cannot be written whose hint and whose keystroke disagree.
 */

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Container, type KeyId, matchesKey, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';

/** The letters that can begin a tag, which are the letters that can be pressed. */
type Letter =
    | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
    | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';

/** A word for an outcome, whose first letter picks it. */
export type Tag = `${Letter}${string}`;

/** The key a tag answers to. The cast is what `Tag` has already established. */
export const keyOf = (tag: Tag): KeyId => tag.charAt(0) as Letter;

/** One outcome: what it is called, what it does, and what comes back. */
export interface Option<Id extends string> {
    readonly id: Id;
    readonly tag: Tag;
    /** What choosing it does, in a clause. */
    readonly label: string;
}

export interface Question<Id extends string> {
    readonly title: string;
    readonly options: readonly Option<Id>[];
    /** Which option the cursor starts on. The first, when it names none. */
    readonly start?: Id;
}

const listTheme = (theme: Theme) => ({
    selectedPrefix: (t: string) => theme.fg('accent', t),
    selectedText: (t: string) => theme.fg('accent', t),
    description: (t: string) => theme.fg('muted', t),
    scrollInfo: (t: string) => theme.fg('dim', t),
    noMatch: (t: string) => theme.fg('warning', t),
});

/** `[carry]`, with the letter that picks it drawn as the letter to press. */
const tagged = (theme: Theme, tag: Tag): string => `[${theme.bold(tag.charAt(0))}${tag.slice(1)}]`;

/**
 * Ask, and return what was picked, or null when the question was dismissed.
 *
 * Escape is an answer the list already has and no option carries it: a menu
 * about leaving needs a way to stay, and every caller so far means the same
 * thing by it.
 */
export function chooseOne<Id extends string>(ctx: ExtensionContext, question: Question<Id>): Promise<Id | null> {
    return ctx.ui.custom<Id | null>((tui, theme, _keys, done) => {
        let closed = false;
        const finish = (outcome: Id | null): void => {
            if (closed) return;
            closed = true;
            done(outcome);
        };

        const items: SelectItem[] = question.options.map((option) => ({
            value: option.id,
            label: tagged(theme, option.tag),
            description: option.label,
        }));

        const list = new SelectList(items, items.length, listTheme(theme), {
            // The tags are short and the labels are sentences, so the column
            // is as wide as the widest tag rather than pi's default 32.
            minPrimaryColumnWidth: 1,
            maxPrimaryColumnWidth: 24,
        });
        const start = question.options.findIndex((option) => option.id === question.start);
        list.setSelectedIndex(start < 0 ? 0 : start);
        list.onSelect = (item) => finish(item.value as Id);
        list.onCancel = () => finish(null);

        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        container.addChild(new Text(theme.fg('accent', theme.bold(question.title)), 1, 0));
        container.addChild(list);
        container.addChild(new Text(theme.fg('dim', 'up/down move, enter choose, esc cancel'), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

        return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
                // Before the list, which reads plain letters as nothing at all
                // but would take enter and the arrows out from under this.
                const pressed = question.options.find((option) => matchesKey(data, keyOf(option.tag)));
                if (pressed !== undefined) {
                    finish(pressed.id);
                    return;
                }
                list.handleInput(data);
                tui.requestRender();
            },
        };
    });
}
