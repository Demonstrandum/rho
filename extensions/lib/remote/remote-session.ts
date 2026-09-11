/**
 * A local session object that answers for a session on another machine.
 *
 * pi's interface reads a session and calls methods on it. Most of what it reads
 * is local by nature -- the theme, the editor settings, the session file it
 * writes -- and only some of it belongs to the machine the agent runs on: what
 * the model is, whether it is streaming, what the messages are, and what a
 * prompt does.
 *
 * So this wraps a real local session and replaces exactly those members. The
 * interface is pi's own, unmodified: the rows, the streaming and the rendering
 * are the ones it always uses, because it is reading what it always reads.
 */

import type { RemoteActions, RemoteState } from './proxy-session';
import type { RpcLink } from './rpc-link';

type Session = Record<string, unknown>;

/**
 * The far side's events, delivered to whoever subscribed to the session.
 *
 * This is what makes it an interface rather than a transcript: `message_update`
 * carries the model's tokens as they arrive, and the renderer already knows
 * what to do with them.
 */
const subscription = (state: RemoteState) => (listener: (event: unknown) => void): (() => void) =>
    state.subscribe((event) => listener(event));

export function remoteSession(
    local: Session,
    link: RpcLink,
    state: RemoteState,
    actions: RemoteActions,
): Session {
    const overrides: Session = {
        // what the far side is doing
        get isStreaming() {
            return state.state.isStreaming === true;
        },
        get isIdle() {
            return state.state.isStreaming !== true;
        },
        get isCompacting() {
            return state.state.isCompacting === true;
        },
        get messages() {
            return state.messages;
        },
        get sessionId() {
            return state.state.sessionId ?? (local.sessionId as string);
        },
        get sessionName() {
            return state.state.sessionName;
        },
        get systemPrompt() {
            return state.state.systemPrompt ?? '';
        },
        get thinkingLevel() {
            return state.state.thinkingLevel ?? 'off';
        },
        get steeringMode() {
            return state.state.steeringMode ?? 'one-at-a-time';
        },
        get followUpMode() {
            return state.state.followUpMode ?? 'one-at-a-time';
        },
        get autoCompactionEnabled() {
            return state.state.autoCompactionEnabled !== false;
        },

        // what it is asked to do
        prompt: (text: string) => actions.prompt(text).then(() => undefined),
        steer: (text: string) => actions.steer(text).then(() => undefined),
        followUp: (text: string) => actions.followUp(text).then(() => undefined),
        compact: () => actions.compact(),
        clearQueue: () => actions.clearQueue(),
        setThinkingLevel: (level: string) => void actions.setThinkingLevel(level),
        setModel: (model: { provider?: string; id?: string }) =>
            void actions.setModel(model.provider ?? '', model.id ?? ''),

        subscribe: subscription(state),

        dispose: () => {
            link.stop();
            (local.dispose as (() => void) | undefined)?.();
        },
    };

    // Everything not named above is the local session's: the settings, the
    // session manager, the resource loader, the extension runner. Reaching for
    // the remote's copy of those would mean reimplementing them.
    return new Proxy(local, {
        get(target, property, receiver) {
            if (property in overrides) {
                const value = Reflect.get(overrides, property, overrides);
                return typeof value === 'function' ? value.bind(overrides) : value;
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, property, value, receiver) {
            return Reflect.set(target, property, value, receiver);
        },
    });
}
