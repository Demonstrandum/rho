import { scenario } from '../lib/scenario';

const TIMINGS = `step              seconds
checkout              4
install deps        212
typecheck            38
unit tests           61
e2e tests           488
upload artefacts     19
total               822

cache: deps cache key includes the commit sha (miss on every run)
e2e: 3 shards configured, 1 runner available (shards run one after another)
`;

export default scenario({
    name: 'plain-english',
    context: "a CI timing breakdown. two causes account for most of the 822 seconds: the dependency cache key includes the commit sha, so install misses every run (212 s), and three e2e shards run one after another on one runner (488 s). the person asks in plain English. writer rule 5.(iii) says a request for plain English means no figurative language at all.",
    prompt: "in plain English, why is our CI build so slow? ci/timings.txt is from the last run.",
    setup(fx) {
        fx.files({ 'ci/timings.txt': TIMINGS });
        fx.initRepo();
    },
    checks: [],
    criteria: [
        { intent: 'task', says: "the reply names both causes with their numbers: install misses the cache because the key includes the commit sha (212 s), and the three e2e shards run one after another on one runner (488 s)." },
        { intent: 'figures', says: "no figurative language at all: no metaphor, simile, or idiom (bottleneck used literally of the slowest step is acceptable; 'the elephant in the room', 'low-hanging fruit', 'the long pole' are not)." },
        { intent: 'assertions', says: "any estimate of savings is derived from the timings shown, or stated as an estimate with its basis." },
    ],
});
