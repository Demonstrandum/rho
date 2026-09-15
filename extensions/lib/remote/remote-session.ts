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
        // Asked from a keystroke, and answered from what the far side last
        // said, because the answer has to be there before the selector draws.
        getUserMessagesForForking: () => state.forkPoints,
        get model() {
            return state.state.model ?? (local.model as unknown);
        },
        get pendingMessageCount() {
            return state.state.pendingMessageCount ?? 0;
        },
        get sessionFile() {
            return state.state.sessionFile ?? (local.sessionFile as string);
        },
        get isBashRunning() {
            // The far side runs the commands; this process runs none.
            return false;
        },
        get isRetrying() {
            return false;
        },

        // what it is asked to do
        prompt: (text: string) => actions.prompt(text).then(() => undefined),
        steer: (text: string) => actions.steer(text).then(() => undefined),
        followUp: (text: string) => actions.followUp(text).then(() => undefined),
        compact: () => actions.compact(),
        clearQueue: () => actions.clearQueue(),
        /**
         * Ask, then read back what the far side now says it is.
         *
         * The corner of the screen reads this snapshot, and a change the far
         * side accepted never reached it: pi tells extensions about a model
         * change with model_select, which is an extension event and does not
         * cross the link, so the footer went on naming the model from the
         * moment of attaching. The same holds for the thinking level, which is
         * drawn beside it.
         */
        setThinkingLevel: (level: string) => void actions.setThinkingLevel(level).then(() => state.refresh()),
        setModel: (model: { provider?: string; id?: string }) =>
            void actions.setModel(model.provider ?? '', model.id ?? '').then(() => state.refresh()),

        // Everything the interface can ask for, asked of the machine the
            // session is on. Escape aborting a local session that is not
            // running, while the far side carries on answering, is the shape of
            // bug this closes: it looks like the abort failed.
        abort: () => actions.abort().then(() => undefined),
        abortBash: () => actions.abortBash().then(() => undefined),
        abortRetry: () => actions.abortRetry().then(() => undefined),
        abortCompaction: () => actions.abort().then(() => undefined),
        executeBash: (command: string) => actions.bash(command).then(() => undefined),
        cycleModel: () => actions.cycleModel().then(() => state.refresh()),
        cycleThinkingLevel: () => actions.cycleThinkingLevel().then(() => state.refresh()),
        setSessionName: (name: string) => void actions.setSessionName(name),
        setSteeringMode: (mode: string) => void actions.setSteeringMode(mode),
        setFollowUpMode: (mode: string) => void actions.setFollowUpMode(mode),
        setAutoCompactionEnabled: (enabled: boolean) => void actions.setAutoCompaction(enabled),
        setAutoRetryEnabled: (enabled: boolean) => void actions.setAutoRetry(enabled),
        getSessionStats: () => actions.sessionStats(),
        getLastAssistantText: () => actions.lastAssistantText(),

        subscribe: subscription(state),

        dispose: () => {
            link.stop();
            (local.dispose as (() => void) | undefined)?.();
        },
    };

    /**
     * Asked of the far side, but there is no way to ask it.
     *
     * Answering these from the local session would be answering about the
     * wrong machine: a transcript this process never wrote, a tree of sessions
     * that is not this one's.
     *
     * They refuse, but they do not throw. The interface calls some of them
     * from a keystroke handler, and an exception there takes the whole client
     * down: double escape opens the fork selector, which asked for the
     * messages to fork from and got an exception instead of an answer.
     */
    const unreachable = new Set([
        'exportToJsonl',
        'exportToHtml',
        'navigateTree',
        'reload',
        'createReplacedSessionContext',
        'recordBashResult',
    ]);

    // Everything not named above is the local session's: the settings, the
    // session manager, the resource loader, the extension runner. Reaching for
    // the remote's copy of those would mean reimplementing them.
    return new Proxy(local, {
        get(target, property, receiver) {
            if (typeof property === 'string' && unreachable.has(property)) {
                return (...args: unknown[]) => {
                    void args;
                    state.refuse(`${property} is not something a session on another machine can answer from here`);
                    return Promise.resolve(undefined);
                };
            }
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
