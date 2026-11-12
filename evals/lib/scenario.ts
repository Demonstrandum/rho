// a scenario is a small invented project, one request, and the behaviour the
// prompt is meant to produce. a check is decided by code (a file, a git ref, a
// pattern in the reply); a criterion is decided by the judge model, for what
// code cannot read.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Intent } from './intents';
import type { Transcript } from './transcript';

export type Verdict =
    | { readonly pass: true }
    | { readonly pass: false; readonly evidence: string };

export const PASS: Verdict = { pass: true };
export const fail = (evidence: string): Verdict => ({ pass: false, evidence });

export interface CheckContext {
    readonly dir: string;
    readonly transcript: Transcript;
    /** relative paths that existed before the agent ran. */
    readonly initialFiles: ReadonlySet<string>;
    readonly fx: Fixture;
}

export interface Check {
    readonly intent: Intent;
    readonly says: string;
    readonly run: (ctx: CheckContext) => Verdict;
}

export interface Criterion {
    readonly intent: Intent;
    readonly says: string;
}

/**
 * an earlier exchange the run continues from. it is written into a session
 * file as if it happened, which is how a correction ("8.(i)") or an approval
 * from an earlier turn is staged without a second model turn deciding it.
 */
export interface SeedTurn {
    readonly user: string;
    readonly assistant: string;
}

export interface Scenario {
    readonly name: string;
    /** what the project is and what makes the request a test, for the judge. */
    readonly context: string;
    readonly seed?: readonly SeedTurn[];
    readonly prompt: string;
    readonly setup: (fx: Fixture) => void;
    readonly checks: readonly Check[];
    readonly criteria: readonly Criterion[];
}

export const scenario = (s: Scenario): Scenario => s;

export class Fixture {
    readonly dir: string;
    /** extra environment for the agent process, set by setup. */
    readonly env: Record<string, string>;

    constructor(dir: string, env: Record<string, string>) {
        this.dir = dir;
        this.env = env;
    }

    path(rel: string): string {
        return join(this.dir, rel);
    }

    files(files: Readonly<Record<string, string>>): void {
        for (const [rel, content] of Object.entries(files)) {
            const path = this.path(rel);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, content);
        }
    }

    executable(rel: string, content: string): void {
        this.files({ [rel]: content });
        chmodSync(this.path(rel), 0o755);
    }

    read(rel: string): string | null {
        const path = this.path(rel);
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
    }

    /** runs a command in the fixture with the agent's environment; returns stdout, throws on failure. */
    sh(command: string, cwd = this.dir): string {
        const result = spawnSync('sh', ['-c', command], {
            cwd,
            env: { ...process.env, ...this.env },
            encoding: 'utf8',
        });
        if (result.status !== 0) {
            throw new Error(`fixture command failed (${result.status}): ${command}\n${result.stderr}`);
        }
        return result.stdout;
    }

    /** like sh, but returns null instead of throwing. */
    try(command: string): string | null {
        try {
            return this.sh(command);
        } catch {
            return null;
        }
    }

    git(args: string): string {
        return this.sh(`git ${args}`);
    }

    initRepo(message = 'initial commit'): void {
        this.git('init -q -b main');
        this.git('add -A');
        this.git(`commit -q -m ${JSON.stringify(message)}`);
    }

    /** a bare repository beside the fixture, set as origin and pushed to. */
    bareRemote(): string {
        const remote = `${this.dir}.origin.git`;
        this.sh(`git init -q --bare ${JSON.stringify(remote)}`);
        this.git(`remote add origin ${JSON.stringify(remote)}`);
        this.git('push -q -u origin main');
        return remote;
    }

    /**
     * a directory early on PATH whose commands report themselves missing,
     * the way zsh does, so "the tool is not installed" can be staged.
     */
    missingCommands(names: readonly string[]): void {
        const bin = `${this.dir}.missing-bin`;
        mkdirSync(bin, { recursive: true });
        for (const name of names) {
            writeFileSync(join(bin, name), `#!/bin/sh\necho "zsh: command not found: ${name}" >&2\nexit 127\n`);
            chmodSync(join(bin, name), 0o755);
        }
        this.env['PATH'] = `${bin}:${this.env['PATH'] ?? process.env['PATH'] ?? ''}`;
    }
}
