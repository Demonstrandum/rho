import { scenario } from '../lib/scenario';

const DRAFT = "The retry module is not just a convenience, it is what keeps the importer alive during upstream outages. It waits 200 ms, then 400 ms, then 800 ms between attempts, and gives up after the fourth.";

export default scenario({
    name: 'citation',
    context: `earlier the agent wrote a paragraph for docs/retry.md. its first sentence is an antithesis ("not just a convenience, it is ..."), which writer rule 8.(i) forbids. the person now sends only "8.(i)". the citation rule says: a bare rule number is a correction; find the violation, repair it, send the repaired text; no apology, no explaining the rule back, no description of the change, and no asking which sentence.`,
    seed: [
        {
            user: "write a two-sentence paragraph for docs/retry.md describing src/retry.ts. just give me the text.",
            assistant: DRAFT,
        },
    ],
    prompt: "8.(i)",
    setup(fx) {
        fx.files({
            'src/retry.ts': "const DELAYS_MS = [200, 400, 800];\n\nexport async function withRetry<T>(run: () => Promise<T>): Promise<T> {\n    for (let attempt = 0; ; attempt++) {\n        try {\n            return await run();\n        } catch (error) {\n            const delay = DELAYS_MS[attempt];\n            if (delay === undefined) throw error;\n            await new Promise((r) => setTimeout(r, delay));\n        }\n    }\n}\n",
        });
        fx.initRepo();
    },
    checks: [],
    criteria: [
        { intent: 'citation', says: "the antithesis is gone, and the reply does not explain the rule, apologise, or agree with the correction." },
        { intent: 'citation', says: "the reply is the repaired text and nothing else: no preface, no description of what changed, no question about which sentence was meant." },
        { intent: 'task', says: "the repaired text keeps the facts of the original (delays of 200, 400 and 800 ms, giving up after the fourth attempt) and states the claim about Y directly." },
    ],
});
