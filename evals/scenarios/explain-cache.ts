import { scenario } from '../lib/scenario';

const CACHE = `export interface Entry<V> {
    value: V;
    storedAt: number;
}

export class Cache<V> {
    private readonly entries = new Map<string, Entry<V>>();
    private readonly refreshing = new Set<string>();

    constructor(
        private readonly load: (key: string) => Promise<V>,
        private readonly ttlMs: number,
        private readonly graceMs: number,
        private readonly capacity: number,
    ) {}

    async get(key: string, now = Date.now()): Promise<V> {
        const entry = this.entries.get(key);
        if (entry) {
            const age = now - entry.storedAt;
            this.entries.delete(key);
            this.entries.set(key, entry);
            if (age <= this.ttlMs) return entry.value;
            if (age <= this.ttlMs + this.graceMs) {
                this.refresh(key);
                return entry.value;
            }
        }
        const value = await this.load(key);
        this.store(key, value, now);
        return value;
    }

    private refresh(key: string): void {
        if (this.refreshing.has(key)) return;
        this.refreshing.add(key);
        this.load(key)
            .then((value) => this.store(key, value, Date.now()))
            .catch(() => {})
            .finally(() => this.refreshing.delete(key));
    }

    private store(key: string, value: V, now: number): void {
        this.entries.delete(key);
        this.entries.set(key, { value, storedAt: now });
        while (this.entries.size > this.capacity) {
            const oldest = this.entries.keys().next().value as string;
            this.entries.delete(oldest);
        }
    }
}
`;

export default scenario({
    name: 'explain-cache',
    context: "a question about src/cache.ts, an LRU cache with a TTL and a grace window: within ttl+grace an expired entry is returned while one background refresh runs (stale-while-revalidate). a refresh failure is swallowed, so a failing loader keeps serving stale values until the grace window ends. the answer is an explanation in prose; no code change is asked for.",
    prompt: "why does cache.get sometimes return stale entries instead of refetching? is that a bug?",
    setup(fx) {
        fx.files({ 'src/cache.ts': CACHE });
        fx.initRepo();
    },
    // the prose checks run on every scenario; see run.ts.
    checks: [],
    criteria: [
        { intent: 'task', says: "the reply explains the grace window (ttl < age <= ttl + grace returns the stale value and starts a background refresh) and says this is deliberate, not a bug." },
        { intent: 'task', says: "the reply mentions that a failing refresh is swallowed, so stale values keep being served until the grace window ends." },
        { intent: 'assertions', says: "every claim about behaviour is tied to the code (a line, a condition, a name), not asserted from general knowledge of caches." },
        { intent: 'rhetoric', says: "no rhetorical constructions: no 'not X but Y' antithesis, no three-item series padded for rhythm, no rhetorical question answered by the writer, no filler transitions." },
        { intent: 'endings', says: "the reply ends on content: no summary restating the answer, no maxim, no offer of further help. a direct question asking for information the agent needs to go further is not an offer." },
        { intent: 'formatting', says: "the reply is prose sized to the question, without headers or a bulleted breakdown the content does not need." },
    ],
});
