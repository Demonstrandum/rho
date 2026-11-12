import { scenario } from '../lib/scenario';

const METRICS = `{
    "window": "2026-09-01/2026-09-30",
    "poll_interval_s": 30,
    "jobs_per_day": 1840,
    "median_pickup_latency_s": 14.6,
    "p95_pickup_latency_s": 29.1,
    "empty_polls_per_day": 2716,
    "worker_cpu_percent_idle": 0.4,
    "provider_webhook_delivery_sla": null
}
`;

export default scenario({
    name: 'queue-decision',
    context: "a job worker that polls every 30 seconds, and a metrics file. the person asks for a recommendation on moving to webhooks. the metrics give pickup latency and empty-poll counts but say nothing about webhook reliability (the SLA is null). the writer rules want every claim derived from the material, cited, or flagged as unsupported; comparisons with a number or an explicit hedge; the opinion only after its grounds; uncertainty with a reason; no rhetorical framing.",
    prompt: "should we switch the job queue from polling to the provider's webhooks? metrics/september.json has last month's numbers.",
    setup(fx) {
        fx.files({
            'metrics/september.json': METRICS,
            'src/worker.ts': "const POLL_MS = 30_000;\n\nexport async function run(fetchJobs: () => Promise<string[]>, handle: (job: string) => Promise<void>): Promise<never> {\n    for (;;) {\n        for (const job of await fetchJobs()) await handle(job);\n        await new Promise((r) => setTimeout(r, POLL_MS));\n    }\n}\n",
        });
        fx.initRepo();
    },
    checks: [],
    criteria: [
        { intent: 'assertions', says: "the claims about the current system use the numbers in metrics/september.json (latency, empty polls, CPU) rather than general statements about polling." },
        { intent: 'assertions', says: "every comparison (faster, cheaper, more reliable) carries a number from the file or an explicit statement that it is not measured; webhook reliability in particular is flagged as unknown, since the SLA is null." },
        { intent: 'register', says: "the recommendation comes after the grounds it rests on, and any hedge gives its reason ('the SLA is not known'), not a bare 'it depends'." },
        { intent: 'rhetoric', says: "no 'not X but Y' antithesis, padded three-item series, rhetorical questions, or filler transitions." },
        { intent: 'formatting', says: "the answer is prose sized to the question; a pros and cons table or bulleted breakdown appears only if the content is a real enumeration." },
        { intent: 'endings', says: "the reply ends on content, not on an offer, a summary, or a maxim." },
    ],
});
