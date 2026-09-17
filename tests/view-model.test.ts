/**
 * The view layer without a terminal.
 *
 * That is the point of it: a component is driven here by sending events and
 * reading the views that come back, which is what a browser or a link would do
 * and what no pi-tui component allows.
 */

import { expect, test, afterEach } from 'bun:test';
import { ViewSession } from '../extensions/lib/view/drive';
import { bind, hintLine, RESERVED } from '../extensions/lib/view/keys';
import { coverage, declare, declared, forgetDeclared } from '../extensions/lib/view/registry';
import {
    canShow,
    componentId,
    plain,
    refusal,
    type ComponentSpec,
    type ListView,
    type View,
    type ViewComponent,
} from '../extensions/lib/view/model';

const spec: ComponentSpec = {
    owner: 'test',
    name: 'sessions',
    purpose: 'the sessions on a host',
    renderings: ['view'],
};

/** A list of two rows, one of which can be stopped. */
const sessions = (): ViewComponent<string | null> & { stopped: string[] } => {
    const rows = ['alpha', 'beta'];
    const stopped: string[] = [];
    const view = (focused?: string): ListView => ({
        kind: 'list',
        title: 'sessions',
        items: rows.map((id) => ({ id, label: id })),
        actions: [{ id: 'stop', label: 'stop', scope: 'item', key: 'd' }],
        ...(focused === undefined ? {} : { focused }),
    });
    return {
        spec,
        stopped,
        onDismiss: null,
        open: () => view(),
        react: (event) => {
            if (event.kind === 'activate') return { kind: 'done', result: event.item };
            if (event.kind === 'action' && event.action === 'stop' && event.item !== undefined) {
                stopped.push(event.item);
                rows.splice(rows.indexOf(event.item), 1);
                return { kind: 'update', view: view(rows[0]) };
            }
            return { kind: 'ignore' };
        },
    };
};

afterEach(() => forgetDeclared());

test('a component is driven by events and answers with views', async () => {
    const component = sessions();
    const session = new ViewSession(component);
    const first = (await session.open()) as ListView;
    expect(first.items.map((item) => item.id)).toEqual(['alpha', 'beta']);

    const after = await session.send({ kind: 'action', action: 'stop', item: 'alpha' });
    expect(component.stopped).toEqual(['alpha']);
    expect(after.kind).toBe('view');
    expect(((after as { view: ListView }).view).items.map((item) => item.id)).toEqual(['beta']);

    const chosen = await session.send({ kind: 'activate', item: 'beta' });
    expect(chosen).toEqual({ kind: 'done', result: 'beta' });
    expect(session.done).toBe(true);
});

test('a dismissal finishes the view whatever the owner says', async () => {
    const component = sessions();
    const session = new ViewSession(component);
    await session.open();
    expect(await session.send({ kind: 'dismiss' })).toEqual({ kind: 'done', result: null });
});

test('an ignored event leaves the view as it was', async () => {
    const session = new ViewSession(sessions());
    const before = await session.open();
    expect(await session.send({ kind: 'focus', item: 'beta' })).toEqual({ kind: 'unchanged' });
    expect(session.current).toBe(before);
});

test('a suspending action runs and the view is asked for again', async () => {
    let asked = 0;
    let ran = 0;
    const component: ViewComponent<null> = {
        spec,
        onDismiss: null,
        open: () => {
            asked += 1;
            return { kind: 'list', title: 'x', items: [{ id: 'a', label: 'a' }] } satisfies View;
        },
        react: () => ({ kind: 'suspend', run: async () => void (ran += 1) }),
    };
    const session = new ViewSession(component);
    await session.open();
    const outcome = await session.send({ kind: 'action', action: 'rename', item: 'a' });
    expect(ran).toBe(1);
    expect(asked).toBe(2);
    expect(outcome.kind).toBe('suspended');
});

test('keys come from the actions, and the hint line from the keys', () => {
    const bindings = bind(
        [
            { id: 'stop', label: 'stop', scope: 'item', key: 'd' },
            { id: 'delete', label: 'delete', scope: 'item' },
        ],
        [{ id: 'raw', label: 'raw json', on: false }],
    );
    expect(bindings.map((binding) => [binding.key, binding.id])).toEqual([
        ['d', 'stop'],
        ['e', 'delete'],
        ['r', 'raw'],
    ]);
    expect(hintLine(bindings, 'open')).toBe('up/down move, enter open, d stop, e delete, r raw json, esc close');
});

test('a view cannot take a key the surface needs', () => {
    const bindings = bind([{ id: 'enter', label: 'enter', scope: 'view', key: 'enter' }]);
    expect(bindings[0]?.key).not.toBe('enter');
    expect(RESERVED).toContain('enter');
});

test('a key already spent goes to whoever declared it first', () => {
    const bindings = bind(
        [
            { id: 'stop', label: 'stop', scope: 'item', key: 'd' },
            { id: 'drop', label: 'drop', scope: 'item', key: 'd' },
        ],
        [],
        ['x'],
    );
    expect(bindings.map((binding) => binding.key)).toEqual(['d', 'r']);
});

test('a front end says what it cannot draw before anything opens', () => {
    declare(spec);
    const intro = declare({ owner: 'startup', name: 'intro', purpose: 'the wordmark animation', renderings: ['terminal'] });
    expect(declared()).toHaveLength(2);

    const browser = coverage(['view']);
    expect(browser.shown.map(componentId)).toEqual(['test/sessions']);
    expect(browser.refused).toHaveLength(1);
    expect(browser.refused[0]?.why).toContain('startup/intro');
    expect(browser.refused[0]?.why).toContain('the wordmark animation');

    expect(canShow(intro, ['view', 'terminal', 'text'])).toBe(true);
    expect(refusal(intro, ['view'])).toContain('offers terminal');
});

test('a line keeps its text whatever tones it carries', () => {
    expect(plain([{ text: 'host ' }, { text: 'dev-box', tone: 'accent' }])).toBe('host dev-box');
    expect(plain('plain')).toBe('plain');
});
