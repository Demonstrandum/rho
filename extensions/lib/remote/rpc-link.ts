/**
 * A pi daemon on another machine, spoken to over ssh.
 *
 * `pi --mode rpc` is a complete session behind a JSONL protocol: commands in,
 * agent events out, the same events the local interface already renders. This
 * carries that protocol across an ssh connection, so a session can run where
 * it will not be switched off while the interface stays here.
 *
 * Framing is pi's, not ours: strict LF, and a line may contain U+2028 inside a
 * JSON string, so the split is on \n alone and nothing else.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface RpcEvent {
    readonly type: string;
    readonly [key: string]: unknown;
}

interface Pending {
    readonly settle: (value: Record<string, unknown>) => void;
    readonly fail: (reason: Error) => void;
    readonly timer: ReturnType<typeof setTimeout> | null;
}

export interface LinkOptions {
    /** How long a command may go unanswered before it is treated as lost. */
    readonly timeoutMs?: number;
    readonly onEvent?: (event: RpcEvent) => void;
    readonly onClosed?: (why: string) => void;
}

/** Long enough for a model call to start answering, short enough to notice a dead link. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class RpcLink {
    private readonly child: ChildProcess;
    private readonly pending = new Map<string, Pending>();
    private readonly listeners = new Set<(event: RpcEvent) => void>();
    private held = '';
    private next = 1;
    private closedWhy: string | null = null;

    constructor(
        command: string,
        args: readonly string[],
        private readonly options: LinkOptions = {},
    ) {
        if (options.onEvent !== undefined) this.listeners.add(options.onEvent);
        this.child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });

        let complaint = '';
        this.child.stderr?.on('data', (chunk: Buffer) => {
            complaint += chunk.toString();
        });
        this.child.stdout?.on('data', (chunk: Buffer) => this.receive(chunk.toString()));
        this.child.on('error', (error) => this.close(error.message));
        this.child.on('close', (code) => this.close(complaint.trim() || `the link closed (exit ${code})`));
    }

    private receive(text: string): void {
        this.held += text;
        const lines = this.held.split('\n');
        this.held = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.replace(/\r$/, '');
            if (trimmed.trim() === '') continue;
            let message: Record<string, unknown>;
            try {
                message = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
                // Not ours: ssh and the shell can write here, and a line that
                // is not JSON is not an event.
                continue;
            }
            const id = typeof message.id === 'string' ? message.id : null;
            if (message.type === 'response' && id !== null) {
                const waiting = this.pending.get(id);
                this.pending.delete(id);
                if (waiting !== undefined) {
                    if (waiting.timer !== null) clearTimeout(waiting.timer);
                    waiting.settle(message);
                }
                continue;
            }
            for (const listener of this.listeners) listener(message as RpcEvent);
        }
    }

    private close(why: string): void {
        if (this.closedWhy !== null) return;
        this.closedWhy = why;
        for (const [, waiting] of this.pending) {
            if (waiting.timer !== null) clearTimeout(waiting.timer);
            waiting.fail(new Error(why));
        }
        this.pending.clear();
        this.options.onClosed?.(why);
    }

    get closed(): string | null {
        return this.closedWhy;
    }

    onEvent(listener: (event: RpcEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Send a command and wait for its response. */
    send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (this.closedWhy !== null) return Promise.reject(new Error(this.closedWhy));
        const id = `r${this.next++}`;
        const limit = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        return new Promise((settle, fail) => {
            const timer =
                limit <= 0
                    ? null
                    : setTimeout(() => {
                          this.pending.delete(id);
                          fail(new Error(`${String(command.type)} went unanswered for ${Math.round(limit / 1000)}s`));
                      }, limit);
            this.pending.set(id, { settle, fail, timer });
            this.child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
        });
    }

    /** Send without waiting, for commands whose effect arrives as events. */
    tell(command: Record<string, unknown>): void {
        if (this.closedWhy !== null) return;
        this.child.stdin?.write(`${JSON.stringify(command)}\n`);
    }

    stop(): void {
        this.child.kill('SIGTERM');
        this.close('closed from this end');
    }
}
