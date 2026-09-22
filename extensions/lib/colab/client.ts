// One marimo server, over HTTP.
//
// marimo's editor is a Starlette app. The endpoints used here are the ones its
// own frontend and the marimo-pair scripts use: `/health` needs no auth,
// `/api/sessions` lists the open notebooks, and `/api/kernel/execute` runs code
// in a session's scratchpad and streams what happened back as server-sent
// events. A session is named in a header, `Marimo-Session-Id`, and a token
// (when the server was started with one) goes in `Authorization: Bearer`.
//
// Pure transport: nothing here knows about cells or `cm`. The shape of what
// comes back from execute is the shape marimo streams (stdout, stderr, done).

export interface ServerAddress {
    readonly url: string;
    /** the auth token, for a server started without --no-token. */
    readonly token?: string;
    /**
     * the skew-protection token every POST but execute must carry. marimo
     * prints it into the page it serves, which is where a browser gets it;
     * `serverToken` reads it from there.
     */
    serverToken?: string;
}

export interface SessionInfo {
    readonly id: string;
    readonly path: string | null;
    readonly filename: string | null;
}

export interface Execution {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
    /** the value of the last expression, as marimo formats it. */
    readonly result: string;
    readonly ms: number;
}

const CONNECT_TIMEOUT_MS = 10_000;
/** a kernel importing a heavy library on its first instantiate can take a while to answer. */
const KERNEL_TIMEOUT_MS = 90_000;

/** the text of an html fragment, entities undone: marimo wraps a scratchpad result in one. */
export function stripHtml(html: string): string {
    return html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|pre)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function headers(address: ServerAddress, sessionId?: string): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (address.token !== undefined && address.token !== '') h.authorization = `Bearer ${address.token}`;
    if (sessionId !== undefined) h['marimo-session-id'] = sessionId;
    if (address.serverToken !== undefined) h['marimo-server-token'] = address.serverToken;
    return h;
}

export const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** read the skew-protection token out of the served page and keep it on the address. */
export async function serverToken(address: ServerAddress): Promise<string | null> {
    try {
        const response = await fetch(`${trimSlash(address.url)}/`, {
            headers: address.token !== undefined && address.token !== '' ? { authorization: `Bearer ${address.token}` } : {},
            signal: AbortSignal.timeout(KERNEL_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const html = await response.text();
        const match = /<marimo-server-token\s+data-token="([^"]+)"/.exec(html);
        if (match === null) return null;
        address.serverToken = match[1];
        return match[1]!;
    } catch {
        return null;
    }
}

/** whether a marimo answers at the address. any other server is `false`. */
export async function healthy(url: string, timeoutMs = 1_500): Promise<boolean> {
    try {
        const response = await fetch(`${trimSlash(url)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return false;
        const text = await response.text();
        return text.includes('healthy');
    } catch {
        return false;
    }
}

export async function listSessions(address: ServerAddress): Promise<SessionInfo[]> {
    const response = await fetch(`${trimSlash(address.url)}/api/sessions`, {
        headers: headers(address),
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`marimo at ${address.url} answered ${response.status} to /api/sessions`);
    const raw = (await response.json()) as Record<string, { path?: string | null; filename?: string | null }>;
    return Object.entries(raw).map(([id, info]) => ({ id, path: info.path ?? null, filename: info.filename ?? null }));
}

/** register the notebook's cells with the kernel and, when asked, run them all. */
export async function instantiate(address: ServerAddress, sessionId: string, autoRun: boolean): Promise<void> {
    const response = await fetch(`${trimSlash(address.url)}/api/kernel/instantiate`, {
        method: 'POST',
        headers: headers(address, sessionId),
        body: JSON.stringify({ objectIds: [], values: [], autoRun }),
        signal: AbortSignal.timeout(KERNEL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`instantiate answered ${response.status}: ${await response.text()}`);
}

export async function interrupt(address: ServerAddress, sessionId: string): Promise<void> {
    await fetch(`${trimSlash(address.url)}/api/kernel/interrupt`, {
        method: 'POST',
        headers: headers(address, sessionId),
        body: '{}',
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    }).catch(() => undefined);
}

/** the kernel's own view of whether it is busy. */
export async function kernelStatus(address: ServerAddress, sessionId: string): Promise<'idle' | 'running' | 'stopped' | 'unknown'> {
    try {
        const response = await fetch(`${trimSlash(address.url)}/api/kernel/status`, {
            headers: headers(address, sessionId),
            signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
        });
        if (!response.ok) return 'unknown';
        const body = (await response.json()) as { state?: string };
        return body.state === 'idle' || body.state === 'running' || body.state === 'stopped' ? body.state : 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Parse the SSE stream `/api/kernel/execute` sends. Events are `stdout`,
 * `stderr` and a final `done`; the body of a non-stream error is returned as
 * stderr so the caller sees the refusal rather than an empty success.
 */
export function parseExecuteStream(text: string): Omit<Execution, 'ms'> {
    let stdout = '';
    let stderr = '';
    let result = '';
    let ok = false;
    let done = false;
    let event = '';
    let unparsed = '';
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
            continue;
        }
        if (line === '') continue;
        if (!line.startsWith('data:')) {
            unparsed += `${line}\n`;
            continue;
        }
        const payload = line.slice(5).trim();
        let data: unknown;
        try {
            data = JSON.parse(payload);
        } catch {
            unparsed += `${payload}\n`;
            continue;
        }
        const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
        if (event === 'stdout') stdout += String(record.data ?? '');
        else if (event === 'stderr') stderr += String(record.data ?? '');
        else if (event === 'done') {
            done = true;
            ok = record.success !== false;
            const output = record.output as { data?: unknown; mimetype?: string } | undefined;
            const raw = output?.data === undefined || output.data === null ? '' : String(output.data);
            result = output?.mimetype === 'text/html' ? stripHtml(raw) : raw;
        }
    }
    if (!done) {
        ok = false;
        let detail = unparsed.trim();
        try {
            const parsed = JSON.parse(detail) as { detail?: string };
            if (typeof parsed.detail === 'string') detail = parsed.detail;
        } catch {
            // not json: keep the text
        }
        stderr += detail === '' ? 'the server ended the stream without a result' : detail;
    }
    return { ok, stdout, stderr, result };
}

/** run code in the session's scratchpad. */
export async function execute(
    address: ServerAddress,
    sessionId: string,
    code: string,
    signal?: AbortSignal,
    timeoutMs = 600_000,
): Promise<Execution> {
    const started = performance.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    let text: string;
    try {
        response = await fetch(`${trimSlash(address.url)}/api/kernel/execute`, {
            method: 'POST',
            headers: headers(address, sessionId),
            body: JSON.stringify({ code }),
            signal: combined,
        });
        text = await response.text();
    } catch (error) {
        // dropping the request is how the kernel is told to stop: marimo
        // interrupts on disconnect. say which of the two signals fired.
        const ms = performance.now() - started;
        const why = timeout.aborted
            ? `interrupted after ${Math.round(ms / 1000)}s (the timeout); the kernel was told to stop`
            : signal?.aborted === true
              ? 'cancelled; the kernel was told to stop'
              : `could not reach ${address.url}: ${(error as Error).message}`;
        return { ok: false, stdout: '', stderr: why, result: '', ms };
    }
    const parsed = parseExecuteStream(text);
    if (!response.ok && parsed.stderr === '') {
        return { ok: false, stdout: '', stderr: `execute answered ${response.status}: ${text.slice(0, 500)}`, result: '', ms: performance.now() - started };
    }
    return { ...parsed, ms: performance.now() - started };
}
