#!/usr/bin/env bun
// checks that the machine can run rho, and says what to do when it cannot.
//
//   bun run doctor                    report on everything, exit 1 on a failure
//   bun tools/preflight.ts --install  the postinstall form: a missing pi is
//                                     only a warning, since installing rho
//                                     before pi is a normal order
//
// rho's install failures used to surface as parse errors or missing-export
// errors from deep inside bun or pi. every requirement here names the tool,
// the version found, the version needed, and the command that fixes it.
//
// this file is deliberately plain: no bundler, no imports from the repo, and
// no syntax newer than the oldest bun that can still parse it, so an old
// runtime reaches the version message instead of failing on the file.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findPiBinary, findPiScope, userPath } from './pi-location';

/** the versions rho is developed against. bump with the code that needs it. */
const MINIMUM = {
    bun: '1.2.0',
    node: '20.0.0',
    pi: '0.84.0',
} as const;

type Severity = 'error' | 'warning';

/**
 * `install` runs inside `bun install`, where the only hard requirement is a
 * runtime new enough to have executed this file correctly. `doctor` is asked
 * for on purpose, so everything rho needs to work is a hard requirement.
 */
type Mode = 'install' | 'doctor';

interface Problem {
    readonly severity: Severity;
    /** what is wrong, in one line. */
    readonly detail: string;
    /** a command the reader can run, or null when there is nothing to run. */
    readonly fix: string | null;
}

interface Report {
    readonly name: string;
    /** the version or path found, for the ok line. */
    readonly found: string | null;
    readonly problem: Problem | null;
}

type Version = readonly [number, number, number];

function parseVersion(text: string): Version | null {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(found: Version, wanted: Version): boolean {
    for (let i = 0; i < 3; i += 1) {
        if (found[i]! > wanted[i]!) return true;
        if (found[i]! < wanted[i]!) return false;
    }
    return true;
}

function commandOutput(command: string, args: readonly string[]): string | null {
    try {
        return execFileSync(command, args as string[], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, PATH: userPath() },
        }).trim();
    } catch {
        return null;
    }
}

function which(command: string): string | null {
    return commandOutput('sh', ['-c', `command -v ${command}`]);
}

function checkVersion(
    name: string,
    foundText: string | null,
    minimum: string,
    fix: string,
    severity: Severity = 'error',
): Report {
    if (foundText === null) {
        return {
            name,
            found: null,
            problem: { severity, detail: `${name} is not installed or not on PATH`, fix },
        };
    }
    const found = parseVersion(foundText);
    const wanted = parseVersion(minimum)!;
    if (!found) {
        return {
            name,
            found: foundText,
            problem: {
                severity: 'warning',
                detail: `could not read a version out of "${foundText}"; wanted ${minimum} or newer`,
                fix,
            },
        };
    }
    if (!isAtLeast(found, wanted)) {
        return {
            name,
            found: found.join('.'),
            problem: {
                severity,
                detail: `${name} ${found.join('.')} is too old; rho needs ${minimum} or newer`,
                fix,
            },
        };
    }
    return { name, found: found.join('.'), problem: null };
}

function checkBun(): Report {
    // when this file runs under bun, the running version is what matters, not
    // whatever `bun` on PATH happens to be.
    const running = process.versions.bun ?? null;
    if (running) {
        return checkVersion('bun', running, MINIMUM.bun, 'bun upgrade');
    }
    return checkVersion('bun', commandOutput('bun', ['--version']), MINIMUM.bun, 'bun upgrade');
}

function checkNode(): Report {
    return checkVersion('node', process.versions.node, MINIMUM.node, 'install node 20 or newer');
}

function checkPi(mode: Mode): Report {
    return checkVersion(
        'pi',
        commandOutput('pi', ['--version']),
        MINIMUM.pi,
        'bun install -g @earendil-works/pi-coding-agent  (or: pi update pi)',
        mode === 'install' ? 'warning' : 'error',
    );
}

/**
 * rho's prototype patches only apply when its copies of pi's packages are the
 * same modules pi loads, which tools/link-pi-packages.ts arranges. this check
 * reports the situation that makes that impossible: no resolvable pi install.
 */
function checkPiScope(mode: Mode): Report {
    const piBin = findPiBinary();
    if (!piBin) {
        return {
            name: 'pi packages',
            found: null,
            problem: {
                severity: mode === 'install' ? 'warning' : 'error',
                detail: 'pi is not on PATH, so rho cannot link against pi\'s own module copies',
                fix: 'bun install -g @earendil-works/pi-coding-agent',
            },
        };
    }
    const scope = findPiScope(piBin);
    if (!scope || !existsSync(join(scope, 'pi-coding-agent'))) {
        return {
            name: 'pi packages',
            found: piBin,
            problem: {
                severity: 'warning',
                detail: `could not find pi's @earendil-works package directory from ${piBin}; rho's render patches will not apply`,
                fix: 'bun install -g @earendil-works/pi-coding-agent && bun tools/link-pi-packages.ts',
            },
        };
    }
    return { name: 'pi packages', found: scope, problem: null };
}

function checkGit(): Report {
    return {
        name: 'git',
        found: which('git'),
        problem: which('git') ? null : {
            severity: 'warning',
            detail: 'git is not on PATH; package installs from git sources will fail',
            fix: 'install git',
        },
    };
}

export function runPreflight(mode: Mode): readonly Report[] {
    return [checkBun(), checkNode(), checkPi(mode), checkPiScope(mode), checkGit()];
}

function report(mode: Mode): number {
    const reports = runPreflight(mode);
    const errors = reports.filter((r) => r.problem?.severity === 'error');
    const warnings = reports.filter((r) => r.problem?.severity === 'warning');

    for (const entry of reports) {
        if (!entry.problem) {
            console.log(`  ok       ${entry.name} ${entry.found ?? ''}`.trimEnd());
            continue;
        }
        const label = entry.problem.severity === 'error' ? 'ERROR  ' : 'warning';
        console.log(`  ${label}  ${entry.name}: ${entry.problem.detail}`);
        if (entry.problem.fix) console.log(`           fix: ${entry.problem.fix}`);
    }

    if (errors.length > 0) {
        console.log('\nrho cannot run here yet. fix the errors above, then re-run `bun install`.');
        return 1;
    }
    if (warnings.length > 0) {
        console.log('\nrho will load, with the caveats above.');
    }
    return 0;
}

if (import.meta.main) {
    process.exit(report(process.argv.includes('--install') ? 'install' : 'doctor'));
}
