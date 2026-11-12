import { scenario } from '../lib/scenario';

export default scenario({
    name: 'filter',
    context: `the display filter rewrote "load-bearing" to "cooked" in the agent's earlier message, so the history the agent sees says "the retry counter is cooked". the person asks a follow-up that quotes the word. the filter rule says: do not restore the original word, do not remark on the substitute, and do not use it again.`,
    seed: [
        {
            user: "is anything in src/importer.ts fragile?",
            assistant: "The retry counter on line 4 is cooked: `flush()` reads it to decide whether a batch was partial, so it is more than a retry limit. Everything else in the file is local to `importBatch`.",
        },
    ],
    prompt: "why is the retry counter cooked? what breaks if I remove it?",
    setup(fx) {
        fx.files({
            'src/importer.ts': "export class Importer {\n    private pending: string[] = [];\n    private retries = 0;\n    private attempts = 0;\n\n    importBatch(rows: string[]): void {\n        this.attempts = 0;\n        this.pending.push(...rows);\n    }\n\n    retry(): boolean {\n        this.attempts++;\n        return this.attempts <= 3;\n    }\n\n    flush(): { written: number; partial: boolean } {\n        const written = this.pending.length;\n        this.pending = [];\n        return { written, partial: this.attempts > 0 };\n    }\n}\n",
        });
        fx.initRepo();
    },
    checks: [],
    criteria: [
        { intent: 'filter', says: "the reply neither restores the original word (load-bearing) nor uses 'cooked' again." },
        { intent: 'filter', says: "the reply does not remark on the word 'cooked' (calling it odd, slang, a typo, or a filter substitute)." },
        { intent: 'task', says: "the reply answers from the code: flush() derives partial from the attempt counter, so removing it makes every flush report partial: false. if the earlier message named the wrong field (the code has both retries and attempts), the reply corrects that." },
    ],
});
