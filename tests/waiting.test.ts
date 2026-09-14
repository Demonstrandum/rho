import { describe, expect, test } from 'bun:test';
import { SILENCE_MS, quiet, waitingLine } from '../extensions/lib/waiting';

describe('silence during a remote turn', () => {
    test('a settled session is not waiting for anything', () => {
        expect(quiet(false, Date.now(), Date.now()).kind).toBe('settled');
        expect(quiet(true, null, Date.now()).kind).toBe('settled');
    });

    test('a turn that is still producing events is working, not silent', () => {
        const now = Date.now();
        expect(quiet(true, now - 2_000, now).kind).toBe('working');
        expect(quiet(true, now - (SILENCE_MS - 1), now).kind).toBe('working');
    });

    test('silence is called at the threshold, not after it', () => {
        const now = Date.now();
        const state = quiet(true, now - SILENCE_MS, now);
        expect(state.kind).toBe('silent');
        expect(state.kind === 'silent' ? state.silentMs : 0).toBe(SILENCE_MS);
    });

    test('the line says how long, in the unit a person would use', () => {
        expect(waitingLine(45_000)).toBe('waiting on the model, 45s without a reply');
        expect(waitingLine(119_000)).toBe('waiting on the model, 119s without a reply');
        expect(waitingLine(296_000)).toBe('waiting on the model, 4m 56s without a reply');
    });
});
