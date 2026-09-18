import { describe, expect, test } from 'bun:test';
import { completeLastWord, lastWord } from '../extensions/lib/complete-words';

/**
 * pi replaces the whole argument text with the value it is given, so a
 * completion holding only the word being typed deletes everything before it:
 * completing the host of
 *
 *   /remote project git@github.com:org/repo.git feature/remote samuel@host
 *
 * left `/remote samuel@host`.
 */

const HOSTS = [{ value: 'samuel@dev-box' }, { value: 'nix@dev-box' }];

describe('the word being typed', () => {
    test('is the tail, and the rest is kept', () => {
        expect(lastWord('project repo.git feature/remote samuel@rob')).toEqual({
            before: 'project repo.git feature/remote ',
            word: 'samuel@rob',
        });
    });

    test('is empty right after a space', () => {
        expect(lastWord('connect ')).toEqual({ before: 'connect ', word: '' });
    });

    test('is the whole text when nothing precedes it', () => {
        expect(lastWord('conn')).toEqual({ before: '', word: 'conn' });
    });
});

describe('completing it', () => {
    test('keeps everything typed before the word', () => {
        const found = completeLastWord('project repo.git feature/remote samuel@dev', HOSTS);
        expect(found?.map((item) => item.value)).toEqual(['project repo.git feature/remote samuel@dev-box']);
        // and the list still reads as a list of choices
        expect(found?.map((item) => item.label)).toEqual(['samuel@dev-box']);
    });

    test('offers everything when the word is empty', () => {
        const found = completeLastWord('connect ', HOSTS);
        expect(found?.map((item) => item.value)).toEqual(['connect samuel@dev-box', 'connect nix@dev-box']);
    });

    test('matches without regard to case', () => {
        expect(completeLastWord('SAM', HOSTS)?.map((item) => item.value)).toEqual(['samuel@dev-box']);
    });

    test('nothing matching is nothing, not an empty list', () => {
        expect(completeLastWord('zz', HOSTS)).toBeNull();
    });

    test('a description travels, and an empty one does not', () => {
        const found = completeLastWord('con', [{ value: 'connect', description: '' }, { value: 'context', description: 'a project' }]);
        expect(found?.[0]).toEqual({ value: 'connect', label: 'connect' });
        expect(found?.[1]).toEqual({ value: 'context', label: 'context', description: 'a project' });
    });
});
