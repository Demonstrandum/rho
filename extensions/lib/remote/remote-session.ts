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

import type { PromptOptions, RemoteActions, RemoteState } from './proxy-session';
import type { RpcLink } from './rpc-link';
import { whereToRun } from './command-routing';
import type { NoticeLevel } from './ui-relay';

type Session = Record<string, unknown>;

/** What the client lends the proxy: a place to speak, and what stays on this machine. */
export interface ClientSurface {
    say(message: string, level: NoticeLevel): void;
    /** commands that run in this interface even though the far side has them too. */
    readonly keepHere: ReadonlySet<string>;
}

/** The extension commands registered in this process, asked at the moment of use. */
function commandsHere(local: Session): ReadonlySet<string> {
    const runner = local.extensionRunner as
        | { getRegisteredCommands?: () => { invocationName?: string }[] }
        | undefined;
    const listed = runner?.getRegisteredCommands?.() ?? [];
    return new Set(
        listed
            .map((command) => command.invocationName)
            .filter((name): name is string => typeof name === 'string'),
    );
}

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
    surface: ClientSurface,
): Session {
    /**
     * Every command the far side is asked to do, with its refusal said out loud.
     *
     * The interface throws none of these away and shows none of them either: a
     * prompt refused because the session is compacting, a model that does not
     * exist there, a session that has gone -- all of them settled a promise
     * nobody was reading. They are the client's own words, not the session's,
     * so they go on the same channel the far side's notifications use.
     */
    const carried = <T>(what: string, asked: Promise<T>): Promise<T | undefined> =>
        asked.catch((error: Error) => {
            surface.say(`${what}: ${error.message}`, 'error');
            return undefined;
        });

    /**
     * A slash command runs where the thing it commands is.
     *
     * pi's interface does not dispatch commands: it calls prompt, and the
     * session runs the command before deciding the text is for the model. With
     * prompt pointed at the far side, every command went there, including the
     * ones about this terminal.
     */
    const promptOrCommand = async (text: string, options?: PromptOptions): Promise<void> => {
        const side = whereToRun(text, {
            here: commandsHere(local),
            there: state.commandsThere,
            keepHere: surface.keepHere,
        });
        if (side === 'here') {
            await (local.prompt as (text: string, options?: unknown) => Promise<void>).call(local, text, options);
            return;
        }
        // Everything the interface said about the prompt goes with it: a
        // message typed while the agent is answering carries the steering
        // behaviour the session needs to queue it, and images carry the images.
        await carried('that message', actions.prompt(text, options ?? {}));
    };

    /**
     * This machine's model, held before anything is redirected.
     *
     * The getter installed at the end of this function shadows the local
     * session's own, so reading `local.model` after that point is a call back
     * into the getter. This is the value it falls back to while the far side
     * has not said what it is running.
     */
    const modelHere = local.model as unknown;

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
            return state.state.model ?? modelHere;
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
        prompt: (text: string, options?: PromptOptions) => promptOrCommand(text, options),
        steer: (text: string, images?: readonly unknown[]) =>
            carried('steering', actions.steer(text, images)).then(() => undefined),
        followUp: (text: string, images?: readonly unknown[]) =>
            carried('queueing that', actions.followUp(text, images)).then(() => undefined),
        compact: () => carried('compaction', actions.compact()),
        clearQueue: () => carried('clearing the queue', actions.clearQueue()),
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
        setThinkingLevel: async (level: string) => {
            state.assume({ thinkingLevel: level });
            await carried('thinking level', actions.setThinkingLevel(level));
            await state.refresh();
        },
        setModel: async (model: { provider?: string; id?: string }) => {
            // Taken as done before the far side says so, because the footer is
            // drawn from the read that follows this call and a round trip does
            // not fit inside it. The refresh puts the far side's own answer in
            // afterwards, which is what corrects a choice it refused.
            state.assume({ model: { ...state.state.model, provider: model.provider, id: model.id } });
            await carried('model', actions.setModel(model.provider ?? '', model.id ?? ''));
            await state.refresh();
        },

        // Everything the interface can ask for, asked of the machine the
            // session is on. Escape aborting a local session that is not
            // running, while the far side carries on answering, is the shape of
            // bug this closes: it looks like the abort failed.
        abort: () => carried('abort', actions.abort()).then(() => undefined),
        abortBash: () => carried('abort', actions.abortBash()).then(() => undefined),
        abortRetry: () => carried('abort', actions.abortRetry()).then(() => undefined),
        abortCompaction: () => carried('abort', actions.abort()).then(() => undefined),
        /**
         * The far side's result, not a discarded one.
         *
         * `!pwd` in the editor is this, and the interface reads exitCode off
         * what comes back to decide how to draw it: returning undefined made
         * every shell escape fail with "Bash command failed: undefined is not
         * an object", after the command had already run on the far side.
         *
         * The daemon answers with pi's own response envelope, so the payload
         * is unwrapped here rather than at every call site.
         */
        executeBash: async (command: string, onChunk?: (chunk: string) => void) => {
            // A command the far side would not run at all -- no session, a
            // link that has gone -- is a refusal rather than a result, and the
            // interface has nowhere to put an exception thrown from here.
            const answer = await actions.bash(command).catch((error: Error) => ({
                data: { output: `${error.message}\n`, exitCode: 1 },
            }));
            const result = ((answer as { data?: unknown })?.data ?? answer) as {
                output?: string;
                exitCode?: number;
            };
            // The interface draws a shell escape from the chunks it is handed
            // and completes it from the result, so a result alone leaves the
            // command on screen with no output under it. The far side's rpc
            // bash answers once, when the command is done, so this arrives in
            // one piece rather than as it is produced.
            if (onChunk !== undefined && typeof result.output === 'string' && result.output !== '') {
                onChunk(result.output);
            }
            return result;
        },
        /** The model it landed on, which is what the interface reports. */
        cycleModel: async () => {
            await carried('model', actions.cycleModel());
            await state.refresh();
            return state.state.model;
        },
        /**
         * Answered here and sent there.
         *
         * The interface reads this from a keystroke and treats undefined as a
         * model with no thinking levels at all, so a promise cannot be what it
         * gets: the level is worked out from the ones the far side reported,
         * held as the current one, and the far side is told.
         */
        cycleThinkingLevel: () => {
            const levels = state.thinkingLevels;
            if (levels.length === 0) return undefined;
            const next = levels[(levels.indexOf(state.state.thinkingLevel ?? 'off') + 1) % levels.length] as string;
            state.assume({ thinkingLevel: next });
            void carried('thinking level', actions.setThinkingLevel(next)).then(() => state.refresh());
            return next;
        },
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

    /**
     * The same two answers, on the session pi bound its extensions to.
     *
     * An extension reads the model from `ctx.model`, and that is not a read of
     * the session the interface holds: pi binds it once, as `() => this.model`
     * on the session that owns the extension runner, which is the local one
     * this proxy wraps. Every extension therefore saw this machine's default
     * model for the whole of a remote session, so the footer named a model the
     * far side was not running and did not move when /model changed it there.
     *
     * Defining the properties on the instance redirects the binding pi has
     * already made, rather than asking it to bind again, so it holds across an
     * extension reload as well.
     */
    Object.defineProperty(local, 'model', {
        configurable: true,
        get: () => state.state.model ?? modelHere,
    });
    Object.defineProperty(local, 'thinkingLevel', {
        configurable: true,
        get: () => state.state.thinkingLevel ?? 'off',
    });

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
