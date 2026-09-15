/**
 * The far side's user interface, carried to the machine with a screen.
 *
 * A session running as a daemon is `pi --mode rpc`, and rpc mode has no
 * terminal: every `ctx.ui` call an extension makes there is emitted as an
 * `extension_ui_request` frame and answered with an `extension_ui_response`.
 * Nothing in the client read those frames, so a command run on the far side
 * wrote its notifications into the void and any dialog it opened waited on an
 * answer that could never come: `/rewind` on a remote session showed nothing
 * at all, which is the symptom this exists to end.
 *
 * The relay is the client's half. It takes each request, hands it to whoever is
 * drawing (an extension, which is the only thing in the client that holds a
 * `ctx.ui`), and sends the answer back down the same link. Requests that arrive
 * before anything is drawing are held rather than dropped, because the interface
 * finishes loading after the link is open.
 */

/** The three levels pi's own notify takes. */
export type NoticeLevel = 'info' | 'warning' | 'error';

export type WidgetPlacement = 'aboveEditor' | 'belowEditor';

/**
 * One thing the far side wants done to the interface.
 *
 * The shape is pi's `RpcExtensionUIRequest`, restated as a discriminated union
 * with the fields named for what they are: parsing at the edge means the rest
 * of the client never inspects a loose record.
 */
export type UiRequest =
    | { readonly method: 'notify'; readonly id: string; readonly message: string; readonly level: NoticeLevel }
    | { readonly method: 'setStatus'; readonly id: string; readonly key: string; readonly text: string | undefined }
    | {
          readonly method: 'setWidget';
          readonly id: string;
          readonly key: string;
          readonly lines: readonly string[] | undefined;
          readonly placement: WidgetPlacement | undefined;
      }
    | { readonly method: 'setTitle'; readonly id: string; readonly title: string }
    | { readonly method: 'setEditorText'; readonly id: string; readonly text: string }
    | {
          readonly method: 'select';
          readonly id: string;
          readonly title: string;
          readonly options: readonly string[];
          readonly timeoutMs: number | undefined;
      }
    | {
          readonly method: 'confirm';
          readonly id: string;
          readonly title: string;
          readonly message: string;
          readonly timeoutMs: number | undefined;
      }
    | {
          readonly method: 'input';
          readonly id: string;
          readonly title: string;
          readonly placeholder: string | undefined;
          readonly timeoutMs: number | undefined;
      }
    | { readonly method: 'editor'; readonly id: string; readonly title: string; readonly prefill: string | undefined };

export type UiMethod = UiRequest['method'];

/** What the far side is waiting for, when it is waiting at all. */
export type UiAnswer = { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true };

/**
 * The methods that block an extension on the far side until they are answered.
 *
 * The rest are told, not asked: pi emits them and carries on, so the client
 * shows them and says nothing back.
 */
export const ANSWERABLE: ReadonlySet<UiMethod> = new Set<UiMethod>(['select', 'confirm', 'input', 'editor']);

export const isAnswerable = (method: UiMethod): boolean => ANSWERABLE.has(method);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asStrings = (value: unknown): readonly string[] | null =>
    Array.isArray(value) && value.every((element) => typeof element === 'string') ? (value as string[]) : null;
const asMillis = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const asLevel = (value: unknown): NoticeLevel =>
    value === 'warning' || value === 'error' || value === 'info' ? value : 'info';
const asPlacement = (value: unknown): WidgetPlacement | undefined =>
    value === 'aboveEditor' || value === 'belowEditor' ? value : undefined;

/**
 * A frame from the wire, as a request this client knows how to draw.
 *
 * Null for anything else, including a method pi adds later: an unknown method
 * that is answerable would park the far side forever, so the caller answers it
 * with a cancellation instead of guessing. `unanswerable` says which case it is.
 */
export function asUiRequest(frame: unknown): UiRequest | null {
    if (typeof frame !== 'object' || frame === null) return null;
    const held = frame as Record<string, unknown>;
    if (held.type !== 'extension_ui_request') return null;
    const id = asString(held.id);
    if (id === null) return null;
    switch (held.method) {
        case 'notify': {
            const message = asString(held.message);
            return message === null ? null : { method: 'notify', id, message, level: asLevel(held.notifyType) };
        }
        case 'setStatus': {
            const key = asString(held.statusKey);
            return key === null ? null : { method: 'setStatus', id, key, text: asString(held.statusText) ?? undefined };
        }
        case 'setWidget': {
            const key = asString(held.widgetKey);
            if (key === null) return null;
            return {
                method: 'setWidget',
                id,
                key,
                lines: asStrings(held.widgetLines) ?? undefined,
                placement: asPlacement(held.widgetPlacement),
            };
        }
        case 'setTitle': {
            const title = asString(held.title);
            return title === null ? null : { method: 'setTitle', id, title };
        }
        case 'set_editor_text': {
            const text = asString(held.text);
            return text === null ? null : { method: 'setEditorText', id, text };
        }
        case 'select': {
            const title = asString(held.title);
            const options = asStrings(held.options);
            if (title === null || options === null) return null;
            return { method: 'select', id, title, options, timeoutMs: asMillis(held.timeout) };
        }
        case 'confirm': {
            const title = asString(held.title);
            if (title === null) return null;
            return {
                method: 'confirm',
                id,
                title,
                message: asString(held.message) ?? '',
                timeoutMs: asMillis(held.timeout),
            };
        }
        case 'input': {
            const title = asString(held.title);
            if (title === null) return null;
            return {
                method: 'input',
                id,
                title,
                placeholder: asString(held.placeholder) ?? undefined,
                timeoutMs: asMillis(held.timeout),
            };
        }
        case 'editor': {
            const title = asString(held.title);
            if (title === null) return null;
            return { method: 'editor', id, title, prefill: asString(held.prefill) ?? undefined };
        }
        default:
            return null;
    }
}

/** A frame whose method this client does not know, and which is waiting for an answer. */
export function unanswerable(frame: unknown): string | null {
    if (typeof frame !== 'object' || frame === null) return null;
    const held = frame as Record<string, unknown>;
    if (held.type !== 'extension_ui_request') return null;
    const id = asString(held.id);
    if (id === null) return null;
    return asUiRequest(frame) === null ? id : null;
}

/** The frame pi's rpc mode reads an answer from. */
export const answerFrame = (id: string, answer: UiAnswer): Record<string, unknown> => ({
    type: 'extension_ui_response',
    id,
    ...answer,
});

/**
 * How many requests are held while nothing is drawing yet.
 *
 * The wait is the time between the link opening and the interface's extensions
 * loading, so the queue is short by nature. The cap is there because a far side
 * that has been talking to nobody for an hour must not grow it without end.
 */
const HELD_LIMIT = 500;

export class UiRelay {
    private handler: ((request: UiRequest) => void) | null = null;
    private readonly held: UiRequest[] = [];
    /** answerable requests the far side is still waiting on. */
    private readonly open = new Set<string>();
    private dropped = 0;
    private spoken = 0;

    constructor(private readonly send: (frame: Record<string, unknown>) => void) {}

    /** A request from the far side, drawn now or held until something can draw it. */
    deliver(request: UiRequest): void {
        if (isAnswerable(request.method)) this.open.add(request.id);
        if (this.handler !== null) {
            this.handler(request);
            return;
        }
        this.held.push(request);
        while (this.held.length > HELD_LIMIT) {
            this.held.shift();
            this.dropped += 1;
        }
    }

    /**
     * Something the client itself has to say, on the same channel.
     *
     * A refusal, a failed command, a line the far side wrote to stderr: each
     * is a notice with no dialog behind it, and the alternative is writing to
     * this process's stderr, which the interface is drawing over.
     */
    say(message: string, level: NoticeLevel = 'info'): void {
        this.deliver({ method: 'notify', id: `rho-local-${++this.spoken}`, message, level });
    }

    /** Whoever draws. One at a time: there is one interface. */
    onRequest(handler: (request: UiRequest) => void): () => void {
        this.handler = handler;
        if (this.dropped > 0) {
            const lost = this.dropped;
            this.dropped = 0;
            handler({
                method: 'notify',
                id: `rho-local-${++this.spoken}`,
                message: `${lost} message${lost === 1 ? '' : 's'} from this session arrived before the interface did and were dropped`,
                level: 'warning',
            });
        }
        while (this.held.length > 0) handler(this.held.shift() as UiRequest);
        return () => {
            if (this.handler === handler) this.handler = null;
        };
    }

    /** Answer one request. A second answer for the same id is ignored. */
    answer(id: string, answer: UiAnswer): void {
        if (!this.open.delete(id)) return;
        this.send(answerFrame(id, answer));
    }

    /** Cancel a request this client cannot draw, so the far side is not parked on it. */
    cancel(id: string): void {
        this.open.add(id);
        this.answer(id, { cancelled: true });
    }

    /** Dialogs still waiting, which is what a client owes the far side when it leaves. */
    get pending(): readonly string[] {
        return [...this.open];
    }
}

/**
 * What the extension that draws needs of the relay.
 *
 * Structural rather than the class itself: the client loads this module by one
 * path and pi loads the extension by another, and a class identity check across
 * two module instances is false for an object that is in every way the relay.
 */
export interface RelayHandle {
    onRequest(handler: (request: UiRequest) => void): () => void;
    answer(id: string, answer: UiAnswer): void;
    cancel(id: string): void;
}

/** Where the client publishes its relay, for the extension that draws it. */
export const RELAY_KEY = '__rho_remote_ui';

export const publishedRelay = (): RelayHandle | null => {
    const held = (globalThis as Record<string, unknown>)[RELAY_KEY];
    if (typeof held !== 'object' || held === null) return null;
    const candidate = held as Partial<RelayHandle>;
    return typeof candidate.onRequest === 'function'
        && typeof candidate.answer === 'function'
        && typeof candidate.cancel === 'function'
        ? (held as RelayHandle)
        : null;
};

export const publishRelay = (relay: RelayHandle): void => {
    (globalThis as Record<string, unknown>)[RELAY_KEY] = relay;
};
