/**
 * Run git, under whichever runtime is hosting this.
 *
 * rho runs under bun here, and bun-runtime.ts enforces that, because code
 * calling Bun.spawn under node raises a ReferenceError that a catch reports as
 * "no git repo": a wrong runtime stating a falsehood about the directory.
 *
 * The agent on another machine cannot be held to the same rule. Its pi runs
 * under node when the host's bun is too old for it, or cannot run a generic
 * binary at all, which is the case on NixOS. So the two places that ask git
 * anything ask through here, and here knows both runtimes.
 */

import { execFile } from 'node:child_process';

export type GitRun =
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly code: number; readonly errors: string; readonly timedOut: boolean }
    | { readonly ok: false; readonly code: null; readonly errors: string; readonly timedOut: false };

interface BunSpawn {
    spawn(
        command: readonly string[],
        options: { cwd: string; stdout: 'pipe'; stderr: 'pipe'; env: Record<string, string | undefined> },
    ): {
        stdout: ReadableStream;
        stderr: ReadableStream;
        exited: Promise<number>;
        kill(): void;
    };
}

const bun = (globalThis as { Bun?: BunSpawn }).Bun;

/** LC_ALL=C so git's own wording is what the caller matches on. */
const environment = (): Record<string, string | undefined> => ({ ...process.env, LC_ALL: 'C' });

export async function runGit(args: readonly string[], cwd: string, timeoutMs: number): Promise<GitRun> {
    if (bun !== undefined) {
        try {
            const proc = bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: environment() });
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, timeoutMs);
            const text = await new Response(proc.stdout).text();
            const errors = await new Response(proc.stderr).text();
            clearTimeout(timer);
            const code = await proc.exited;
            if (code === 0) return { ok: true, text };
            return { ok: false, code, errors, timedOut };
        } catch (error) {
            return { ok: false, code: null, errors: error instanceof Error ? error.message : String(error), timedOut: false };
        }
    }

    return new Promise<GitRun>((settle) => {
        execFile(
            'git',
            [...args],
            { cwd, timeout: timeoutMs, env: environment(), encoding: 'utf8' },
            (error, stdout, stderr) => {
                if (error === null) {
                    settle({ ok: true, text: stdout });
                    return;
                }
                const killed = (error as { killed?: boolean }).killed === true;
                const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
                if (code === null) {
                    settle({ ok: false, code: null, errors: stderr || error.message, timedOut: false });
                    return;
                }
                settle({ ok: false, code, errors: stderr || error.message, timedOut: killed });
            },
        );
    });
}
