import { describe, expect, test } from 'bun:test';
import { commandName, whereToRun } from '../extensions/lib/remote/command-routing';
import type { CommandKnowledge } from '../extensions/lib/remote/command-routing';

/**
 * Where a slash command runs when the session is on another machine.
 *
 * pi hands the text to `session.prompt`, which in a remote client is a call to
 * the far side, so every command went there: `/theme` changed the colours of a
 * process with no terminal and `/exit` reached the model as a prompt.
 */

const knowledge = (parts: Partial<Record<keyof CommandKnowledge, string[]>>): CommandKnowledge => ({
    here: new Set(parts.here ?? []),
    there: new Set(parts.there ?? []),
    keepHere: new Set(parts.keepHere ?? []),
});

describe('naming the command', () => {
    test('with and without arguments', () => {
        expect(commandName('/rewind')).toBe('rewind');
        expect(commandName('/theme gruvbox')).toBe('theme');
        expect(commandName('/theme\tgruvbox')).toBe('theme');
    });

    test('a line that is not a command has no name', () => {
        expect(commandName('what is in this directory')).toBeNull();
        expect(commandName('/')).toBeNull();
        expect(commandName('')).toBeNull();
    });
});

describe('which machine runs it', () => {
    test('prose goes to the session', () => {
        expect(whereToRun('list the files', knowledge({ here: ['theme'] }))).toBe('there');
    });

    test('a command about this terminal stays here', () => {
        expect(whereToRun('/theme gruvbox', knowledge({ here: ['theme'], there: ['theme'], keepHere: ['theme'] }))).toBe(
            'here',
        );
    });

    test('a command about the files runs where the files are', () => {
        expect(whereToRun('/rewind', knowledge({ here: ['rewind'], there: ['rewind'], keepHere: ['theme'] }))).toBe(
            'there',
        );
    });

    test('a command only this machine has runs here, listed or not', () => {
        expect(whereToRun('/stash', knowledge({ here: ['stash'] }))).toBe('here');
    });

    test('a command only the far side has runs there', () => {
        expect(whereToRun('/deploy', knowledge({ here: ['theme'], there: ['deploy'] }))).toBe('there');
    });

    test('a name neither side knows goes to the session, which expands templates and skills', () => {
        expect(whereToRun('/skill:auditor', knowledge({ here: ['theme'] }))).toBe('there');
    });

    test('naming a command that is not registered here does not keep it here', () => {
        expect(whereToRun('/rewind', knowledge({ there: ['rewind'], keepHere: ['rewind'] }))).toBe('there');
    });
});
