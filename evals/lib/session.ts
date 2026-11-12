// writes a scenario's seed turns as a pi session file (format v3, see pi's
// docs/session-format.md), so the run continues a conversation that never
// happened. the assistant turns carry zero usage and name the model under
// test, which is what pi would have recorded.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { SeedTurn } from './scenario';

const ZERO_USAGE = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function writeSeedSession(path: string, cwd: string, model: string, seed: readonly SeedTurn[]): void {
    const [provider = '', id = ''] = model.split('/');
    const start = Date.now() - 60_000 * (seed.length + 1);
    const lines: unknown[] = [{ type: 'session', version: 3, id: randomUUID(), timestamp: new Date(start).toISOString(), cwd }];
    let parentId: string | null = null;
    let tick = start;
    const entry = (message: Record<string, unknown>): void => {
        tick += 1000;
        const entryId = randomUUID().replace(/-/g, '').slice(0, 8);
        lines.push({ type: 'message', id: entryId, parentId, timestamp: new Date(tick).toISOString(), message: { ...message, timestamp: tick } });
        parentId = entryId;
    };
    for (const turn of seed) {
        entry({ role: 'user', content: turn.user });
        entry({
            role: 'assistant',
            content: [{ type: 'text', text: turn.assistant }],
            api: 'anthropic-messages',
            provider,
            model: id,
            usage: ZERO_USAGE,
            stopReason: 'stop',
        });
    }
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}
