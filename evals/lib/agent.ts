// runs pi once, headless, on a fixture: the installed pi with rho loaded the
// way a real session loads it, so the prompt under test is the prompt sent.
import { spawn } from 'node:child_process';

export interface ModelSpec {
    /** provider/id, as --model takes it. */
    readonly model: string;
    readonly thinking: ThinkingLevel;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function parseModelSpec(text: string, fallback: ThinkingLevel = 'medium'): ModelSpec {
    const colon = text.lastIndexOf(':');
    const level = colon > 0 ? text.slice(colon + 1) : '';
    if ((LEVELS as readonly string[]).includes(level)) {
        return { model: text.slice(0, colon), thinking: level as ThinkingLevel };
    }
    return { model: text, thinking: fallback };
}

export const specLabel = (spec: ModelSpec): string => `${spec.model.split('/').pop()}:${spec.thinking}`;

export interface PiRun {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number | null;
    readonly timedOut: boolean;
    readonly seconds: number;
}

export interface PiOptions {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
}

export function runPi(options: PiOptions): Promise<PiRun> {
    const started = performance.now();
    return new Promise((resolve) => {
        const child = spawn('pi', [...options.args], {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, options.timeoutMs);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({
                stdout: Buffer.concat(out).toString('utf8'),
                stderr: Buffer.concat(err).toString('utf8'),
                code,
                timedOut,
                seconds: (performance.now() - started) / 1000,
            });
        });
    });
}

/** with a session file the run continues it; without one nothing is saved. */
export function agentArgs(spec: ModelSpec, prompt: string, session: string | null = null): string[] {
    const sessionArgs = session === null ? ['--no-session'] : ['--session', session];
    return ['--mode', 'json', '-p', ...sessionArgs, '--model', spec.model, '--thinking', spec.thinking, prompt];
}
