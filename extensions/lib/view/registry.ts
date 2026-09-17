/**
 * What this session can show, and what it cannot.
 *
 * A front end that discovers it cannot draw something at the moment a person
 * asks for it has already failed: the pane is open, the command has run, and
 * the only thing left is an apology. Components declare their renderings when
 * they are registered, so the question is answerable before anything is opened,
 * and `/prompt` on a session drawn over a link can say which of its views will
 * work rather than showing nothing.
 *
 * Registration is by component rather than by command because one command can
 * open several (the payload outline and the pager behind it are two), and a
 * front end refuses or accepts each in turn.
 */

import { canShow, componentId, refusal, type ComponentSpec, type Rendering } from './model';

const registered = new Map<string, ComponentSpec>();

/** Declare a component. A second registration of the same id replaces it. */
export function declare(spec: ComponentSpec): ComponentSpec {
    registered.set(componentId(spec), spec);
    return spec;
}

export const declared = (): readonly ComponentSpec[] => [...registered.values()];

export const specFor = (id: string): ComponentSpec | undefined => registered.get(id);

/** Forget everything, for a test that declares components of its own. */
export function forgetDeclared(): void {
    registered.clear();
}

export interface Coverage {
    readonly shown: readonly ComponentSpec[];
    readonly refused: readonly { readonly spec: ComponentSpec; readonly why: string }[];
}

/**
 * What a front end offering these renderings could and could not draw.
 *
 * The answer is a list rather than a count: a person told that two views are
 * unavailable learns nothing, and one told that the tetris intro and the
 * rewind picker are terminal-only knows exactly what they are missing.
 */
export function coverage(offered: readonly Rendering[]): Coverage {
    const shown: ComponentSpec[] = [];
    const refused: { spec: ComponentSpec; why: string }[] = [];
    for (const spec of registered.values()) {
        if (canShow(spec, offered)) shown.push(spec);
        else refused.push({ spec, why: refusal(spec, offered) });
    }
    return { shown, refused };
}
