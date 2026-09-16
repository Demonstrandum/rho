import { test, expect } from 'bun:test';
import { INITIAL_KEYS, countOf, step, type KeyState } from '../extensions/lib/tree-keys';

function run(keys: readonly string[]): { state: KeyState; actions: unknown[] } {
    let state = INITIAL_KEYS;
    const actions: unknown[] = [];
    for (const key of keys) {
        const next = step(state, key);
        state = next.state;
        actions.push(next.action);
    }
    return { state, actions };
}

test('a bare motion moves one row', () => {
    expect(run(['j']).actions).toEqual([{ kind: 'move', by: 1 }]);
    expect(run(['k']).actions).toEqual([{ kind: 'move', by: -1 }]);
    expect(run(['\x1b[A']).actions).toEqual([{ kind: 'move', by: -1 }]);
});

test('a count applies to the next motion and then clears', () => {
    const { state, actions } = run(['1', '2', 'k', 'j']);
    expect(actions).toEqual([{ kind: 'none' }, { kind: 'none' }, { kind: 'move', by: -12 }, { kind: 'move', by: 1 }]);
    expect(state.count).toBe('');
});

test('a leading zero is not a count', () => {
    expect(run(['0']).actions).toEqual([{ kind: 'passthrough' }]);
    expect(run(['1', '0', 'j']).actions.at(-1)).toEqual({ kind: 'move', by: 10 });
});

test('shift extends by the same count, typed or as an arrow', () => {
    expect(run(['3', 'K']).actions.at(-1)).toEqual({ kind: 'extend', by: -3 });
    expect(run(['\x1b[1;2B']).actions).toEqual([{ kind: 'extend', by: 1 }]);
});

test('verbs and the ends of the branch are their own actions', () => {
    expect(run(['v']).actions).toEqual([{ kind: 'select-toggle' }]);
    expect(run(['G']).actions).toEqual([{ kind: 'extend-to', end: 'leaf' }]);
    expect(run(['g']).actions).toEqual([{ kind: 'extend-to', end: 'root' }]);
    expect(run(['d']).actions).toEqual([{ kind: 'verb', verb: 'delete' }]);
    expect(run(['s']).actions).toEqual([{ kind: 'verb', verb: 'summarize' }]);
    expect(run(['U']).actions).toEqual([{ kind: 'undo', all: true }]);
});

test('search mode takes every printable key and gives back two', () => {
    const search = step(INITIAL_KEYS, '/');
    expect(search.action).toEqual({ kind: 'mode', mode: 'search' });
    expect(search.state.mode).toBe('search');

    expect(step(search.state, 'd').action).toEqual({ kind: 'passthrough' });
    expect(step(search.state, '4').action).toEqual({ kind: 'passthrough' });
    expect(step(search.state, '\x7f').action).toEqual({ kind: 'passthrough' });

    const left = step(search.state, '\x1b');
    expect(left.action).toEqual({ kind: 'mode', mode: 'normal' });
    expect(left.state.mode).toBe('normal');
    expect(step(search.state, '\r').state.mode).toBe('normal');
});

test("keys the view does not claim are left to pi's handler", () => {
    expect(run(['\x0f']).actions).toEqual([{ kind: 'passthrough' }]);
    expect(run(['L']).actions).toEqual([{ kind: 'passthrough' }]);
});

test('the count in force is one when none was typed', () => {
    expect(countOf(INITIAL_KEYS)).toBe(1);
    expect(countOf({ mode: 'normal', count: '07' })).toBe(7);
});

test('a digit typed while shift is held is the digit', () => {
    expect(run(['#', '\x1b[1;2A']).actions.at(-1)).toEqual({ kind: 'extend', by: -3 });
    expect(run(['!', ')', 'j']).actions.at(-1)).toEqual({ kind: 'move', by: 10 });
});
