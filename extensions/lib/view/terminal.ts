/**
 * The terminal front end: one way of drawing a view, not the definition of one.
 *
 * Everything terminal-shaped lives here. The keys come from `view/keys.ts`, the
 * colours from the theme by tone, the scrolling from `lib/pager.ts`, and the
 * loop from `view/drive.ts`. A view says there is an action called `stop`; this
 * file decides that it is `d`, that the hint line says so, and that the row goes
 * dim while it runs.
 *
 * A component that declares only `terminal` is run as it always was, through
 * `ctx.ui.custom`. That path is not a failure here: it is the declared shape of
 * that component, and the only thing lost is being able to draw it anywhere
 * else.
 */

import type { ExtensionContext, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Container, type KeyId, matchesKey, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';
import { Pager } from '../pager';
import { bind, boundTo, hintLine, type Binding } from './keys';
import { ViewSession } from './drive';
import {
    canShow,
    isViewComponent,
    plain,
    refusal,
    type DocumentView,
    type Line,
    type ListView,
    type Presentable,
    type Rendering,
    type Span,
    type Tone,
    type TreeView,
    type View,
} from './model';

/** What a terminal can draw: the model, a pi-tui component, or plain lines. */
export const TERMINAL_RENDERINGS: readonly Rendering[] = ['view', 'terminal', 'text'];

const VISIBLE_ROWS = 12;
const PREVIEW_ROWS = 8;

/** Tones are meaning; this is the only place they become colours. */
const paint = (theme: Theme, line: Line): string => {
    if (typeof line === 'string') return line;
    return line.map((span: Span) => (span.tone === undefined ? span.text : theme.fg(toneColour(span.tone), span.text))).join('');
};

/**
 * Tone to theme colour.
 *
 * Named separately from the tones because a theme's colour names are pi's and
 * the tones are the model's: `muted` exists in both by luck, and a future tone
 * with no colour of its own falls back rather than failing to render.
 */
const toneColour = (tone: Tone): ThemeColor => {
    switch (tone) {
        case 'accent':
            return 'accent';
        case 'dim':
            return 'dim';
        case 'muted':
            return 'muted';
        case 'success':
            return 'success';
        case 'warning':
            return 'warning';
        case 'error':
            return 'error';
        case 'text':
            return 'text';
    }
};

const listTheme = (theme: Theme) => ({
    selectedPrefix: (t: string) => theme.fg('accent', t),
    selectedText: (t: string) => theme.fg('accent', t),
    description: (t: string) => theme.fg('muted', t),
    scrollInfo: (t: string) => theme.fg('dim', t),
    noMatch: (t: string) => theme.fg('warning', t),
});

/** A row of a list or a tree, as SelectList wants it. */
const rowOf = (theme: Theme, id: string, label: Line, description: Line | undefined, busy: string | undefined): SelectItem => {
    const parts = [description === undefined ? '' : paint(theme, description), busy === undefined ? '' : `${busy}...`].filter(
        (part) => part !== '',
    );
    return { value: id, label: paint(theme, label), description: parts.join(', ') };
};

const listRows = (theme: Theme, view: ListView): SelectItem[] =>
    view.items.map((item) => rowOf(theme, item.id, item.label, item.description, item.busy));

const treeRows = (theme: Theme, view: TreeView): SelectItem[] =>
    view.nodes.map((node) => {
        const mark = node.expandable ? (node.expanded === true ? '- ' : '+ ') : '  ';
        const indent = '  '.repeat(node.depth);
        const label: Line = typeof node.label === 'string' ? `${indent}${mark}${node.label}` : [{ text: `${indent}${mark}` }, ...node.label];
        return rowOf(theme, node.id, label, node.detail, undefined);
    });

/** How one opening of a view ended. A suspending action closes and reopens. */
type Round<T> =
    | { readonly kind: 'done'; readonly result: T | undefined }
    | { readonly kind: 'reopen'; readonly run?: () => Promise<void> };

/**
 * Draw one view until it finishes or has to give the terminal up.
 *
 * The session owns what the view becomes; this owns what the keys mean and
 * what is on screen. Every event goes through the session, so an owner that
 * replaces the view on focus (the theme preview) and one that only answers
 * enter (the payload list) take the same path here.
 */
function openView<T>(ctx: ExtensionContext, session: ViewSession<T>, view: View): Promise<Round<T>> {
    return ctx.ui.custom<Round<T>>((tui, theme, _keys, done) => {
        let shown: View = view;
        let closed = false;
        let previewLines: readonly Line[] = [];

        const container = new Container();
        const title = new Text('', 1, 0);
        const hints = new Text('', 1, 0);
        const preview = new Text('', 1, 0);
        let body: SelectList | Pager = buildBody(shown);
        let bindings: readonly Binding[] = bindingsFor(shown);

        function bindingsFor(current: View): readonly Binding[] {
            return current.kind === 'document'
                ? bind([], current.toggles ?? [])
                : bind(current.actions ?? [], []);
        }

        function buildBody(current: View): SelectList | Pager {
            if (current.kind === 'document') {
                return new Pager(
                    { title: plain(current.title), lines: current.lines.map((line) => paint(theme, line)) },
                    theme,
                    () => tui.terminal.rows,
                    [],
                );
            }
            const rows = current.kind === 'list' ? listRows(theme, current) : treeRows(theme, current);
            const made = new SelectList(rows, Math.min(Math.max(rows.length, 1), VISIBLE_ROWS), listTheme(theme));
            const focused = current.kind === 'list' ? current.focused : current.focused;
            if (focused !== undefined) {
                const at = rows.findIndex((row) => row.value === focused);
                if (at >= 0) made.setSelectedIndex(at);
            }
            made.onSelectionChange = (item) => void send({ kind: 'focus', item: item.value });
            made.onSelect = (item) => void activate(item.value);
            made.onCancel = () => void send({ kind: 'dismiss' });
            return made;
        }

        const finish = (round: Round<T>): void => {
            if (closed) return;
            closed = true;
            done(round);
        };

        const redraw = (): void => {
            if (closed) return;
            const made = buildBody(shown);
            const at = container.children.indexOf(body as never);
            if (at >= 0) container.children[at] = made as never;
            body = made;
            bindings = bindingsFor(shown);
            title.setText(theme.fg('accent', theme.bold(plain(shown.title))));
            hints.setText(theme.fg('dim', hintLine(bindings, chooseWord(shown))));
            preview.setText(previewLines.map((line) => paint(theme, line)).join('\n'));
            container.invalidate();
            tui.requestRender();
        };

        async function send(event: Parameters<ViewSession<T>['send']>[0]): Promise<void> {
            if (closed) return;
            const outcome = await session.send(event);
            if (outcome.kind === 'done') {
                finish({ kind: 'done', result: outcome.result });
                return;
            }
            if (outcome.kind === 'view' || outcome.kind === 'suspended') {
                shown = outcome.view;
                await loadPreview();
                redraw();
            }
        }

        /** The focused row drawn in full, for a view that asked for one. */
        async function loadPreview(): Promise<void> {
            if (shown.kind !== 'list' || shown.preview === undefined) {
                previewLines = [];
                return;
            }
            const item = shown.focused ?? shown.items[0]?.id;
            if (item === undefined) {
                previewLines = [];
                return;
            }
            previewLines = (await session.previewOf(item))?.slice(0, shown.preview.lines ?? PREVIEW_ROWS) ?? [];
        }

        async function activate(id: string): Promise<void> {
            if (shown.kind === 'tree') {
                const node = shown.nodes.find((candidate) => candidate.id === id);
                if (node?.expandable === true) {
                    await send({ kind: 'expand', node: id, open: node.expanded !== true });
                    return;
                }
            }
            await send({ kind: 'activate', item: id });
        }

        title.setText(theme.fg('accent', theme.bold(plain(shown.title))));
        hints.setText(theme.fg('dim', hintLine(bindings, chooseWord(shown))));
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        container.addChild(title);
        if (shown.note !== undefined) container.addChild(new Text(paint(theme, shown.note), 1, 0));
        container.addChild(body as never);
        container.addChild(preview);
        container.addChild(hints);
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        void loadPreview().then(redraw);

        return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
                if (closed) return;
                if (matchesKey(data, 'escape')) {
                    void send({ kind: 'dismiss' });
                    return;
                }
                const hit = bindings.find((binding) => matchesKey(data, binding.key as KeyId));
                if (hit !== undefined) {
                    if (hit.kind === 'toggle' && shown.kind === 'document') {
                        const toggle = (shown.toggles ?? []).find((candidate) => candidate.id === hit.id);
                        void send({ kind: 'toggle', toggle: hit.id, on: toggle?.on !== true });
                        return;
                    }
                    const selected = body instanceof SelectList ? body.getSelectedItem() : null;
                    const action = actionsOf(shown).find((candidate) => candidate.id === hit.id);
                    if (action?.suspends === true) {
                        finish({
                            kind: 'reopen',
                            run: async () => {
                                await session.send({
                                    kind: 'action',
                                    action: hit.id,
                                    ...(selected === null ? {} : { item: selected.value }),
                                });
                            },
                        });
                        return;
                    }
                    void send({
                        kind: 'action',
                        action: hit.id,
                        ...(selected === null ? {} : { item: selected.value }),
                    });
                    return;
                }
                body.handleInput(data);
                tui.requestRender();
            },
        };
    });
}

const actionsOf = (view: View) => (view.kind === 'document' ? [] : (view.actions ?? []));

const chooseWord = (view: View): string | undefined => {
    if (view.kind === 'list') return view.choose ?? 'select';
    if (view.kind === 'tree') return 'open';
    return undefined;
};

/**
 * Show a component in this terminal, whatever shape it declared.
 *
 * A component this front end cannot draw is refused by name and by reason,
 * before anything opens: an empty pane that closes itself teaches nobody which
 * of the two sides could not do it.
 */
export async function present<T>(ctx: ExtensionContext, component: Presentable<T>): Promise<T | undefined> {
    if (!canShow(component.spec, TERMINAL_RENDERINGS)) {
        ctx.ui.notify(refusal(component.spec, TERMINAL_RENDERINGS), 'warning');
        return undefined;
    }
    if (!isViewComponent(component)) return component.run();

    const session = new ViewSession<T>(component);
    let view = await session.open();
    if (view.kind === 'list' && view.items.length === 0) {
        if (view.empty !== undefined) ctx.ui.notify(view.empty, 'info');
        return component.onDismiss;
    }
    for (;;) {
        const round = await openView(ctx, session, view);
        if (round.kind === 'done') return round.result;
        await round.run?.();
        if (session.done) return session.result;
        view = session.current ?? (await session.open());
    }
}

/** The plain-text rendering, for a front end with neither of the others. */
export const asText = <T>(component: Presentable<T>, view: View | null): readonly string[] => {
    const own = component.text?.();
    if (own !== undefined) return own.map(plain);
    if (view === null) return [];
    if (view.kind === 'document') return [plain(view.title), ...view.lines.map(plain)];
    if (view.kind === 'list') return [plain(view.title), ...view.items.map((item) => plain(item.label))];
    return [plain(view.title), ...view.nodes.map((node) => `${'  '.repeat(node.depth)}${plain(node.label)}`)];
};

export type { DocumentView, ListView };
