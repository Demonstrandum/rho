/**
 * A bare host name is accepted because ssh already knows the rest of it, so
 * what is tested here is which names count as known: patterns, negation,
 * Include, and the catch-all that must not make every typo a machine.
 */

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredHosts, forgetSshConfig, isConfiguredHost, readSshConfig } from '../extensions/lib/remote/ssh-config';

const made: string[] = [];

const configWith = (text: string, extra: Record<string, string> = {}): string => {
    const dir = mkdtempSync(join(tmpdir(), 'rho-ssh-'));
    made.push(dir);
    for (const [name, body] of Object.entries(extra)) {
        const path = join(dir, name);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, body);
    }
    const file = join(dir, 'config');
    writeFileSync(file, text);
    forgetSshConfig();
    return file;
};

afterEach(() => {
    forgetSshConfig();
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a declared host is known, and its user is nobody else\u2019s business', () => {
    const config = readSshConfig(configWith('Host dev-box\n  User samuel\n  HostName 10.0.0.1\n'));
    expect(isConfiguredHost('dev-box', config)).toBe(true);
    expect(configuredHosts(config)).toEqual(['dev-box']);
});

test('a pattern matches, anchored at both ends', () => {
    const config = readSshConfig(configWith('Host gpu-*\n  User ubuntu\n'));
    expect(isConfiguredHost('gpu-4', config)).toBe(true);
    expect(isConfiguredHost('old-gpu-4', config)).toBe(false);
    expect(configuredHosts(config)).toEqual([]);
});

test('a catch-all does not make every word a host', () => {
    const config = readSshConfig(configWith('Host *\n  ForwardAgent yes\n'));
    expect(isConfiguredHost('not-a-machine', config)).toBe(false);
});

test('negation wins wherever it matches', () => {
    const config = readSshConfig(configWith('Host *-vm !exp2-vm\n  ForwardAgent yes\n'));
    expect(isConfiguredHost('tali-vm', config)).toBe(true);
    expect(isConfiguredHost('exp2-vm', config)).toBe(false);
});

test('several names on one Host line each count', () => {
    const config = readSshConfig(configWith('Host pool-1 pool-2\n  User dev\n'));
    expect(configuredHosts(config)).toEqual(['pool-1', 'pool-2']);
});

test('Include is followed, relative to the file that names it', () => {
    const file = configWith('Include extra/work\nHost here\n', { 'extra/work': 'Host elsewhere\n  User dev\n' });
    const config = readSshConfig(file);
    expect(isConfiguredHost('elsewhere', config)).toBe(true);
    expect(configuredHosts(config)).toEqual(['elsewhere', 'here']);
});

test('a missing config knows nothing rather than throwing', () => {
    const config = readSshConfig(join(tmpdir(), 'rho-ssh-absent', 'config'));
    expect(configuredHosts(config)).toEqual([]);
    expect(isConfiguredHost('anything', config)).toBe(false);
});
