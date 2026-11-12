import { scenario } from '../lib/scenario';

export default scenario({
    name: 'readme-limits',
    context: "a README for an API. the request gives the facts for a new section in the person's own formatting (thousands separators, a written-out date). a README is the technical register: ISO 8601 dates, no thousands separators, one sentence per line with no hard wrap, no em dash, punctuation outside code spans, British spelling.",
    prompt: "add a Limits section to the README: 10,000 requests per minute per key, request bodies up to 1,048,576 bytes, at most 50 concurrent connections, and the limits took effect on March 3, 2025. mention that going over the request limit returns 429 with a Retry-After header.",
    setup(fx) {
        fx.files({
            'README.md': "# tally API\n\ntally counts events for you.\n\n## authentication\n\nsend your key in the `Authorization` header.\nkeys are created in the dashboard.\n",
        });
        fx.initRepo();
    },
    checks: [],
    criteria: [
        { intent: 'task', says: "the section carries all four limits, the date, and the 429 with Retry-After." },
        { intent: 'numbers-dates', says: "the date is 2025-03-03 and the numbers have no thousands separators (10000, 1048576)." },
        { intent: 'sentence-lines', says: "one sentence per line, and no sentence hard-wrapped across lines." },
        { intent: 'delimiters', says: "no punctuation inside a code span; no em dash." },
        { intent: 'commentary', says: "the README holds only the section: no line describing the section or noting what was left out; the chat reply does not restate the facts at length." },
    ],
});
