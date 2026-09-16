/**
 * What `~/.ssh/config` already knows about a machine.
 *
 * Every connection here is made by spawning `ssh`, so the user, the address,
 * the port, the key and the jump host are resolved by ssh itself from its own
 * config. `ssh dev-box` is therefore complete, and an agent that greps the
 * config for a `User` line to build `samuel@dev-box` is recomputing what
 * the next process would have computed anyway, from a file it cannot parse
 * correctly (patterns, negation, Include, Match).
 *
 * Two things were missing. `bash`'s `on` refused a bare word that was not an
 * attached environment, which is the one place a host name had to carry a user
 * to be accepted. And nothing said which names exist, so the names had to be
 * found by reading the file.
 *
 * This reads the config for names only: which `Host` patterns are declared,
 * and whether a given word matches one. What each name resolves to stays
 * ssh's business.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** One `Host` pattern as written, with the `!` prefix taken off. */
export interface HostPattern {
    readonly pattern: string;
    readonly negated: boolean;
}

/** The `Host` patterns of one config file and everything it includes. */
export interface SshConfig {
    /** every pattern, in file order, negations included. */
    readonly patterns: readonly HostPattern[];
    /** the patterns that are plain names, which are the ones worth listing. */
    readonly names: readonly string[];
}

const EMPTY: SshConfig = { patterns: [], names: [] };

const isPattern = (text: string): boolean => text.includes('*') || text.includes('?');

/**
 * ssh globs are `*` and `?` over the whole name, and nothing else: no
 * character class, no path semantics. Anchored, because `gpu-*` must not
 * match `old-gpu-1`.
 */
const asRegExp = (pattern: string): RegExp => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
};

/** `Include` takes a path relative to `~/.ssh`, and may itself glob. */
const included = (argument: string, from: string): string[] => {
    const expanded = argument.startsWith('~/') ? join(homedir(), argument.slice(2)) : argument;
    const absolute = isAbsolute(expanded) ? expanded : join(from, expanded);
    if (isPattern(absolute)) {
        const parent = dirname(absolute);
        if (!existsSync(parent)) return [];
        const match = asRegExp(absolute);
        try {
            return readdirSync(parent)
                .map((entry) => join(parent, entry))
                .filter((candidate) => match.test(candidate));
        } catch {
            return [];
        }
    }
    return existsSync(absolute) ? [absolute] : [];
};

const parseInto = (file: string, seen: Set<string>, patterns: HostPattern[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let text: string;
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        return;
    }
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const [keyword = '', ...rest] = trimmed.split(/[\s=]+/);
        const word = keyword.toLowerCase();
        if (word === 'host') {
            for (const entry of rest) {
                if (entry === '') continue;
                patterns.push(
                    entry.startsWith('!') ? { pattern: entry.slice(1), negated: true } : { pattern: entry, negated: false },
                );
            }
            continue;
        }
        if (word === 'include') {
            for (const argument of rest) {
                for (const target of included(argument, dirname(file))) parseInto(target, seen, patterns);
            }
        }
    }
};

/** The default location, which is the only one ssh reads without being told. */
export const userConfigPath = (): string => join(homedir(), '.ssh', 'config');

/**
 * Read once per process. The config changes when a machine is added, which is
 * rare, and a session that misses one can still be given `user@host`.
 */
let cached: { readonly file: string; readonly config: SshConfig } | null = null;

export function readSshConfig(file: string = userConfigPath()): SshConfig {
    if (cached !== null && cached.file === file) return cached.config;
    if (!existsSync(file)) {
        cached = { file, config: EMPTY };
        return EMPTY;
    }
    const patterns: HostPattern[] = [];
    parseInto(file, new Set<string>(), patterns);
    const names: string[] = [];
    for (const { pattern, negated } of patterns) {
        if (negated || isPattern(pattern) || names.includes(pattern)) continue;
        names.push(pattern);
    }
    const config: SshConfig = { patterns, names };
    cached = { file, config };
    return config;
}

/** Forget the cached read, for a test that writes a config of its own. */
export function forgetSshConfig(): void {
    cached = null;
}

/**
 * Whether ssh would find a `Host` block for this name.
 *
 * A negated pattern wins wherever it matches, which is what ssh does with
 * `Host *vm !exp2-vm`. A name matched only by `*` is not treated as known: a
 * catch-all applies to every string, including a typo.
 */
export function isConfiguredHost(name: string, config: SshConfig = readSshConfig()): boolean {
    let found = false;
    for (const { pattern, negated } of config.patterns) {
        if (pattern === '*') continue;
        if (!asRegExp(pattern).test(name)) continue;
        if (negated) return false;
        found = true;
    }
    return found;
}

/** The plain names, for an error message or a listing. */
export function configuredHosts(config: SshConfig = readSshConfig()): readonly string[] {
    return config.names;
}
