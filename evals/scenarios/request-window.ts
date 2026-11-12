import { scenario } from '../lib/scenario';

const CLIENT = `export interface Endpoint {
    name: string;
    url: string;
}

export async function call(endpoint: Endpoint, body: unknown): Promise<Response> {
    return fetch(endpoint.url, { method: 'POST', body: JSON.stringify(body) });
}
`;

export default scenario({
    name: 'request-window',
    context: "a small HTTP client. the request needs per-endpoint state (the last 100 request timestamps, and a status of ok, throttled, or banned). the house rules want the status as a literal union or enum rather than strings compared ad hoc, a typed record or class rather than a loose dictionary, and a bounded window as a named data structure (a ring buffer or a class with push) rather than array.shift() bookkeeping at each call site.",
    prompt: "src/client.ts needs client-side rate limiting: per endpoint, remember the timestamps of the last 100 requests and a status (ok, throttled after more than 50 requests in 10 seconds, banned after the server answers 403). call() should refuse to send while an endpoint is throttled or banned.",
    setup(fx) {
        fx.files({
            'src/client.ts': CLIENT,
            'package.json': '{\n    "name": "client",\n    "type": "module"\n}\n',
        });
        fx.initRepo();
    },
    checks: [],
    criteria: [
        { intent: 'task', says: "call() refuses while an endpoint is throttled (over 50 requests in 10 seconds) or banned (after a 403), and the window holds at most 100 timestamps." },
        { intent: 'type-design', says: "the status is a literal union or an enum, not bare strings compared at use sites." },
        { intent: 'type-design', says: "per-endpoint state is a typed record, interface, or class (a Map keyed by endpoint name holding that type is fine), not an untyped object or Record<string, any>." },
        { intent: 'type-design', says: "the bounded window is its own data structure (a ring buffer, or a class or function that owns the push and the bound), not array push and shift written inline where requests are recorded." },
        { intent: 'minimal-comments', says: "comments, if any, say why rather than restating the code." },
    ],
});
