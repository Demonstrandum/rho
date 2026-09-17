/**
 * What an extension shows, described rather than drawn.
 *
 * pi's extension UI is a closed set of methods, and every one of them relays to
 * a session on another machine except `custom`, which hands over a pi-tui
 * component. A component is a function from a width to escape sequences: it
 * cannot cross a link, a browser cannot draw it, and a front end cannot say in
 * advance that it will not be able to show it. That is why `/prompt` on a
 * remote session opens nothing at all.
 *
 * The split here is between what a view is and how it is painted. A list of
 * sessions with an action called `stop` is a fact about the extension; that the
 * action is bound to `d`, drawn in an accent colour and framed by half blocks
 * is a fact about this terminal. The first crosses a wire and the second does
 * not have to.
 *
 * Nothing in this file imports pi-tui, and nothing in it knows a key code or a
 * colour. `view/terminal.ts` is one front end over it; a browser would be
 * another, and `terminalOnly` is how a component says honestly that it can only
 * be the first.
 */

/** Meaning, not colour. A front end decides what each one looks like. */
export type Tone = 'text' | 'dim' | 'muted' | 'accent' | 'success' | 'warning' | 'error';

/** A run of text with its meaning. A bare string is `text`. */
export interface Span {
    readonly text: string;
    readonly tone?: Tone;
}

export type Line = string | readonly Span[];

/**
 * What a key would be, where there are keys.
 *
 * A hint and not an instruction: a front end with no keyboard ignores it, and
 * one that has a keyboard may still have the key taken. The front end decides,
 * and `view/keys.ts` is where this one decides.
 */
export type KeyHint = string;

/** Who may be acted on: one row, or the view as a whole. */
export type ActionScope = 'item' | 'view';

export interface ViewAction {
    readonly id: string;
    /** what it does, as a verb: `stop`, `delete`, `open`. */
    readonly label: string;
    readonly scope: ActionScope;
    /** the key this action would like, when the front end has keys. */
    readonly key?: KeyHint;
    /** what the row says while it runs. Defaults to the label. */
    readonly busy?: string;
    /**
     * The action asks its own question, so a front end drawing this view
     * inside a modal surface has to close it first and open it again after.
     */
    readonly suspends?: boolean;
    /** irreversible, for a front end that marks such things. */
    readonly destructive?: boolean;
}

export interface ListItem {
    readonly id: string;
    readonly label: Line;
    readonly description?: Line;
    /** a heading this row belongs under. */
    readonly group?: string;
    /** an action is running on this row, and this is the word for it. */
    readonly busy?: string;
    /** actions that apply to this row, by id. Absent means all item actions. */
    readonly actions?: readonly string[];
}

interface ViewBase {
    readonly title: Line;
    /** one line under the view, when it needs saying beyond the actions. */
    readonly note?: Line;
}

/**
 * Rows to choose from, act on, and filter.
 *
 * Covers every picker here: the stash, the prompt log, the session list, the
 * theme menu. `preview` is what made the theme picker a special case, and it
 * is a property of the view rather than a second kind: the front end asks for
 * the preview of the focused row and draws it wherever it has room.
 */
export interface ListView extends ViewBase {
    readonly kind: 'list';
    readonly items: readonly ListItem[];
    readonly actions?: readonly ViewAction[];
    /** what enter does, as a verb. Defaults to `select`. */
    readonly choose?: string;
    /** the row the cursor is on, by id. */
    readonly focused?: string;
    /** the rows are filtered by this text, which the front end may edit. */
    readonly filter?: { readonly text: string; readonly placeholder?: string };
    /** what to say when there are no rows at all. */
    readonly empty?: string;
    /** the focused row is shown as well as listed, and this is how. */
    readonly preview?: PreviewShape;
}

/** Where a preview goes and how big it may be. The content comes per row. */
export interface PreviewShape {
    readonly place: 'beside' | 'below';
    /** rows, or the front end's own idea of a sensible size when absent. */
    readonly lines?: number;
}

/** Scrollable text, with switches that change what is in it. */
export interface DocumentView extends ViewBase {
    readonly kind: 'document';
    readonly lines: readonly Line[];
    readonly toggles?: readonly ViewToggle[];
    /** monospaced, indentation significant: a payload, a diff, a log. */
    readonly preformatted?: boolean;
}

export interface ViewToggle {
    readonly id: string;
    readonly label: string;
    readonly on: boolean;
    readonly key?: KeyHint;
}

/** A node in a tree that is read as it is opened, not built in full. */
export interface TreeNode {
    readonly id: string;
    readonly label: Line;
    readonly detail?: Line;
    /** null means it is not known yet whether this node has children. */
    readonly expandable: boolean;
    readonly expanded?: boolean;
    readonly depth: number;
}

/**
 * A tree the owner expands a node at a time.
 *
 * Kept distinct from a list because the front end has to know that opening a
 * row is navigation rather than a choice: a browser draws a disclosure arrow, a
 * terminal draws a gutter, and neither should have to infer it from the labels.
 */
export interface TreeView extends ViewBase {
    readonly kind: 'tree';
    readonly nodes: readonly TreeNode[];
    readonly focused?: string;
    readonly actions?: readonly ViewAction[];
}

export type View = ListView | DocumentView | TreeView;

export type ViewKind = View['kind'];

/** What the person did. Named for the intent, never for the key. */
export type ViewEvent =
    /** the cursor moved onto a row. */
    | { readonly kind: 'focus'; readonly item: string }
    /** enter, a click, a tap: the row was chosen. */
    | { readonly kind: 'activate'; readonly item: string }
    /** a named action, on a row or on the view. */
    | { readonly kind: 'action'; readonly action: string; readonly item?: string }
    | { readonly kind: 'filter'; readonly text: string }
    | { readonly kind: 'toggle'; readonly toggle: string; readonly on: boolean }
    /** a tree node was opened or closed. */
    | { readonly kind: 'expand'; readonly node: string; readonly open: boolean }
    /** escape, a close button, the surface going away. */
    | { readonly kind: 'dismiss' };

/** What the owner does about it. */
export type Reaction<T> =
    /** draw this instead; the front end keeps the cursor where it can. */
    | { readonly kind: 'update'; readonly view: View }
    /** the view is finished and this is its answer. */
    | { readonly kind: 'done'; readonly result: T }
    /** nothing to do; the front end carries on as it was. */
    | { readonly kind: 'ignore' }
    /** the view is closed, this runs, and the view opens again. */
    | { readonly kind: 'suspend'; readonly run: () => Promise<void> };

/**
 * How a component can be painted, best first.
 *
 * `view` means this file's model, which any front end can draw. `terminal`
 * means a pi-tui component and nothing else. `text` is the degraded form: a
 * few lines that say what the component would have shown, for a front end that
 * has neither.
 *
 * The declaration is metadata, so a front end can say what it will not be able
 * to show before anything is opened, rather than presenting an empty pane.
 */
export type Rendering = 'view' | 'terminal' | 'text';

export interface ComponentSpec {
    /** the extension that owns it: `prompt-inspect`, `stash`, `pi-rewind`. */
    readonly owner: string;
    /** unique within the owner: `payload-outline`, `session-list`. */
    readonly name: string;
    /** what it is for, one line, for a front end listing what it cannot draw. */
    readonly purpose: string;
    readonly renderings: readonly Rendering[];
}

export const componentId = (spec: ComponentSpec): string => `${spec.owner}/${spec.name}`;

/**
 * A view and the owner that answers for it.
 *
 * `open` is called once, `react` for every event, and the component is done
 * when a reaction says so or the view is dismissed.
 */
export interface ViewComponent<T> {
    readonly spec: ComponentSpec;
    open(): View | Promise<View>;
    react?(event: ViewEvent): Reaction<T> | Promise<Reaction<T>>;
    /** the preview for a row, when the view asked for one. */
    preview?(item: string): readonly Line[] | Promise<readonly Line[]>;
    /** what a front end with no view model shows instead. */
    text?(): readonly Line[];
    /** what the view answers with when it is dismissed. */
    readonly onDismiss?: T;
}

/** Every component declares its renderings; this is the honest default. */
export const TERMINAL_ONLY: readonly Rendering[] = ['terminal'];

/**
 * A component that can only be a pi-tui component.
 *
 * The intro animations are the real cases: they paint frames, they are not a
 * list of anything, and pretending otherwise would mean describing box
 * characters in a model meant to outlive terminals. Saying so is a statement a
 * front end can act on, which an absent declaration is not.
 */
export interface TerminalComponent<T> {
    readonly spec: ComponentSpec;
    /** run it, given whatever the terminal front end passes through. */
    run(): Promise<T>;
    text?(): readonly Line[];
}

export type Presentable<T> = ViewComponent<T> | TerminalComponent<T>;

export const isViewComponent = <T>(component: Presentable<T>): component is ViewComponent<T> =>
    (component as ViewComponent<T>).open !== undefined;

/** Whether a front end offering these renderings can show this component. */
export function canShow(spec: ComponentSpec, offered: readonly Rendering[]): boolean {
    return spec.renderings.some((rendering) => offered.includes(rendering));
}

/** Why it cannot, in a sentence that names the component and the reason. */
export function refusal(spec: ComponentSpec, offered: readonly Rendering[]): string {
    return (
        `${componentId(spec)} (${spec.purpose}) offers ${spec.renderings.join(', ')}; `
        + `this interface draws ${offered.join(', ')}`
    );
}

/** The text of a line, whatever form it is in, for a front end without tones. */
export const plain = (line: Line): string =>
    typeof line === 'string' ? line : line.map((span) => span.text).join('');
