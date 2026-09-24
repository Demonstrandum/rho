import { test, expect } from 'bun:test';
import {
    declareUsage,
    formsFromDescription,
    hintFor,
    parseForm,
    type KnownCommand,
} from '../extensions/lib/chrome/command-usage';

const known: KnownCommand[] = [
    { name: 'remote', description: 'run the session on another machine' },
    { name: 'restart', description: 'start this session again' },
    { name: 'project', description: 'check out a repository' },
    { name: 'slack', description: 'attach this session: /slack <app>, /slack off, /slack add <app>' },
    { name: 'noswap', description: 'toggle the word filter' },
    { name: 'rho', description: 'rho config management' },
];

test('a form is read into literals and values', () => {
    const form = parseForm('remote', '/remote project <repo> [branch] [as <name>]');
    expect(form.tokens).toEqual([
        { kind: 'literal', word: 'project', optional: false },
        { kind: 'value', label: 'repo', optional: false },
        { kind: 'value', label: 'branch', optional: true },
        { kind: 'literal', word: 'as', optional: true },
        { kind: 'value', label: 'name', optional: true },
    ]);
});

test('an address in a form is a value, not a literal', () => {
    const form = parseForm('remote', '/remote create <name> user@host');
    expect(form.tokens[2]).toEqual({ kind: 'value', label: 'user@host', optional: false });
});

test('a description gives up the forms it already writes', () => {
    expect(formsFromDescription('slack', known[3].description ?? '')).toEqual([
        '/slack <app>',
        '/slack off',
        '/slack add <app>',
    ]);
});

test('a half-typed name resolves only while it picks one command', () => {
    expect(hintFor('/proj', known)).toBe('/project <repo> [branch] [as <name>]');
    expect(hintFor('/re', known)).toBeUndefined();
});

test('the typed verb picks the form', () => {
    expect(hintFor('/remote project ', known)).toBe(
        '/remote project <repo> [branch] [user@host] [as <name>]',
    );
    expect(hintFor('/remote stop pluto', known)).toBe('/remote stop <name>');
    expect(hintFor('/remote cre', known)).toBe('/remote create <name> <user@host>');
});

test('a command with several forms offers the choice between them', () => {
    expect(hintFor('/remote ', known)).toBe('/remote [connect|create|project|list|manage|stop]');
});

test('a half-typed verb narrows the choice, and finishing it picks the form', () => {
    expect(hintFor('/remote c', known)).toBe('/remote [connect|create]');
    expect(hintFor('/remote conn', known)).toBe('/remote connect <name>');
});

test('the choice comes after the words already settled', () => {
    expect(hintFor('/rho config ', known)).toBe('/rho config [overwrite|write]');
});

test('a word no form takes leaves no hint', () => {
    expect(hintFor('/remote zzz ', known)).toBeUndefined();
});

test('a command with nothing declared and nothing in its description has no hint', () => {
    expect(hintFor('/noswap ', known)).toBeUndefined();
});

test('text that is not a command has no hint', () => {
    expect(hintFor('write me a haiku', known)).toBeUndefined();
    expect(hintFor('/remote create pluto\nand more', known)).toBeUndefined();
});

test('a declaration replaces what a command had', () => {
    declareUsage('noswap', ['/noswap [on|off]']);
    expect(hintFor('/noswap ', known)).toBe('/noswap [on|off]');
});
