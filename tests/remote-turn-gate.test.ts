import { describe, expect, test } from 'bun:test';
import { TurnGate } from '../extensions/lib/remote/turn-gate';

const through = (gate: TurnGate, types: readonly string[]): string[] => types.filter((type) => gate.admits(type));

describe('whole turns only', () => {
    test('a turn seen from the start passes entire', () => {
        const gate = new TurnGate();
        const seen = ['agent_start', 'turn_start', 'message_start', 'message_end', 'turn_end', 'agent_end'];
        expect(through(gate, seen)).toEqual(seen);
    });

    test('an end without a beginning is held back', () => {
        // What a client attaching mid-turn hears first. Passing it on made the
        // token rate divide a whole turn's output by a millisecond.
        const gate = new TurnGate();
        expect(through(gate, ['message_update', 'turn_end', 'agent_end', 'agent_settled'])).toEqual([
            'message_update',
            'agent_settled',
        ]);
    });

    test('the turn after that one passes, having been seen whole', () => {
        const gate = new TurnGate();
        through(gate, ['turn_end', 'agent_end']);
        expect(through(gate, ['agent_start', 'turn_start', 'turn_end', 'agent_end'])).toEqual([
            'agent_start',
            'turn_start',
            'turn_end',
            'agent_end',
        ]);
    });

    test('a turn is closed once, so a repeated end is held back', () => {
        const gate = new TurnGate();
        expect(through(gate, ['turn_start', 'turn_end', 'turn_end'])).toEqual(['turn_start', 'turn_end']);
    });

    test('events that are not a turn boundary always pass', () => {
        const gate = new TurnGate();
        expect(through(gate, ['message_start', 'tool_execution_end', 'agent_settled'])).toEqual([
            'message_start',
            'tool_execution_end',
            'agent_settled',
        ]);
    });

    test('several turns inside one agent run', () => {
        const gate = new TurnGate();
        const seen = ['agent_start', 'turn_start', 'turn_end', 'turn_start', 'turn_end', 'agent_end'];
        expect(through(gate, seen)).toEqual(seen);
        expect(gate.inside).toEqual([]);
    });
});
