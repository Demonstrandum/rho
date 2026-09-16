import { describe, expect, test } from 'bun:test';
import { keyOf } from '../extensions/lib/choice';
import {
    carryEnv,
    leavingIn,
    leavingNamed,
    leavingOptions,
    leavingTitle,
    withoutLeaving,
} from '../extensions/lib/remote/leaving';

describe('the ways out of an interface onto a session elsewhere', () => {
    test('carrying is offered only when the two sides hold one conversation', () => {
        expect(leavingOptions(true).map((option) => option.id)).toEqual(['carry', 'leave', 'exit']);
        expect(leavingOptions(false).map((option) => option.id)).toEqual(['leave', 'exit']);
    });

    test('each option answers to its own first letter', () => {
        expect(leavingOptions(true).map((option) => keyOf(option.tag))).toEqual(['c', 'l', 'e']);
    });

    test('the title names the session and the machine, and says what does not change', () => {
        expect(leavingTitle('lucid-4821', 'cloud-a100')).toBe('lucid-4821 on cloud-a100 keeps running either way.');
        expect(leavingTitle('overnight', 'local')).toBe('overnight keeps running either way.');
        expect(leavingTitle('overnight', undefined)).toBe('overnight keeps running either way.');
    });
});

describe('the choice on its way to the process that acts on it', () => {
    test('a word typed after /detach is a choice, and anything else is not', () => {
        expect(leavingNamed(' Carry ')).toBe('carry');
        expect(leavingNamed('exit')).toBe('exit');
        expect(leavingNamed('overnight')).toBeNull();
    });

    test('the marker is read out of everything else the client said', () => {
        expect(leavingIn('warming up\nrho-leave: leave\n')).toBe('leave');
        expect(leavingIn('nothing was said about leaving')).toBeNull();
    });

    test('the last marker wins, since an earlier one belongs to an earlier attach', () => {
        expect(leavingIn('rho-leave: carry\nrho-leave: exit\n')).toBe('exit');
    });

    test('what is left after the marker is still a reason for stopping', () => {
        expect(withoutLeaving('no session called lucid\nrho-leave: exit\n').trim()).toBe('no session called lucid');
    });

    test('the environment says whether carrying is possible at all', () => {
        expect(carryEnv(true)).toEqual({ RHO_CARRY_BACK: '1' });
        expect(carryEnv(false)).toEqual({ RHO_CARRY_BACK: '0' });
    });
});
