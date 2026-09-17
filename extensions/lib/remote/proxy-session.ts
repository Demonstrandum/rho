/**
 * A session that lives on another machine, presented as a local one.
 *
 * pi's interface is built on an AgentSession: it reads state from it, calls
 * methods on it, and subscribes to its events. None of that has to happen in
 * this process. This implements the same surface over an rpc link, so the
 * interface renders a session running elsewhere with its own components, its
 * own streaming and its own rows -- rather than a copy of them drawn from
 * messages, which is what the first attempt did and why it looked like a log.
 *
 * What is faithful here: every action is a command to the far side, and every
 * piece of state is either the far side's answer or an event it sent. Nothing
 * is inferred locally, because a local guess that disagrees with the session is
 * worse than a slow answer.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { RpcEvent, RpcLink } from './rpc-link';
import { StreamingMessage, reshape } from './event-shape';

export type Listener = (event: RpcEvent) => void;

interface Snapshot {
    model?: { id?: string; provider?: string; contextWindow?: number };
    pendingMessageCount?: number;
    sessionFile?: string;
    thinkingLevel?: string;
    isStreaming?: boolean;
    isCompacting?: boolean;
    steeringMode?: string;
    followUpMode?: string;
    sessionId?: string;
    sessionName?: string;
    systemPrompt?: string;
    autoCompactionEnabled?: boolean;
}

/**
 * The far side's state, kept current by its events.
 *
 * A command's response is the truth at the moment it was asked; an event is the
 * truth as it changes. Both are applied here so the interface never has to ask
 * mid-render, which is what would make it feel slower than the terminal it
 * replaces.
 */
export class RemoteState {
    private snapshot: Snapshot = {};
    private history: AgentMessage[] = [];
    private readonly listeners = new Set<Listener>();

    constructor(private readonly link: RpcLink) {
        link.onEvent((event) => this.apply(event));
    }

    private replaying = false;
    /** the assistant message being built, so every update carries the whole of it. */
    private readonly streaming = new StreamingMessage();

    private apply(raw: RpcEvent): void {
        const shaped = reshape(raw, this.streaming);
        if (shaped === null) return;
        const event = shaped;
        // History, bracketed by the daemon: applied to the message list so an
        // attaching viewer has something to draw, never treated as the model
        // answering now.
        if (event.type === 'rho_replay_start') {
            this.replaying = true;
            return;
        }
        if (event.type === 'rho_replay_end') {
            this.replaying = false;
            return;
        }

        switch (event.type) {
            case 'agent_start':
                this.snapshot.isStreaming = true;
                // A turn is about to be drawn, and the corner is drawn with it:
                // whatever the far side has been told since the last one --
                // its own /model, a second interface onto the same session --
                // is asked for here, where a round trip costs nothing because
                // the answer is not being waited on.
                void this.syncState();
                break;
            case 'agent_settled':
            case 'agent_end':
                this.snapshot.isStreaming = false;
                break;
            case 'model_select':
                // The far side chose a model, and the footer reads this. Its
                // own /model picker changed it there and the corner here went
                // on naming the one before, because nothing carried the choice
                // back: the state was only ever read at attach.
                {
                    const chosen = (event as { model?: { id?: string; provider?: string } }).model;
                    if (chosen !== undefined) this.snapshot.model = { ...this.snapshot.model, ...chosen };
                }
                break;
            case 'compaction_start':
                this.snapshot.isCompacting = true;
                break;
            case 'compaction_end':
                this.snapshot.isCompacting = false;
                break;
            case 'message_end': {
                const message = event.message as AgentMessage | undefined;
                if (message !== undefined) this.history.push(message);
                this.noticeModelDrift(message);
                // An assistant message that carries a refusal instead of an
                // answer reads as the model having nothing to say: the token
                // expiring on the far side looked exactly like silence. The
                // trouble is kept where a client can ask for it.
                const trouble = message?.role === 'assistant' ? message.errorMessage : undefined;
                // Only from a live turn: a refusal in the replayed history is
                // something that already happened, and reporting it as current
                // is how a fixed problem gets diagnosed twice.
                if (!this.replaying && typeof trouble === 'string' && trouble !== '') this.lastTrouble = trouble;
                break;
            }
        }
        if (!this.replaying) {
            for (const listener of this.listeners) listener(event);
        }
    }

    /**
     * A model chosen on the far side, noticed from what it answered with.
     *
     * pi reports a model change to its extensions and not to its session
     * subscribers, so `model_select` is raised inside the daemon and never
     * reaches the wire: `/model` run in another interface onto the same
     * session left this one naming the model from the moment it attached. An
     * assistant message carries the provider and model that produced it, so a
     * turn answered by something else is the change arriving, one turn late.
     * The state is asked for again rather than patched, because the footer
     * reads the context window and the reasoning levels off the whole model.
     */
    private noticeModelDrift(message: AgentMessage | undefined): void {
        if (message?.role !== 'assistant') return;
        const named = this.snapshot.model;
        if (named?.id === message.model && named?.provider === message.provider) return;
        void this.syncState();
    }

    /**
     * The far side's state and nothing else.
     *
     * `refresh` asks five questions, which is what attaching costs; this is
     * the one of them that goes stale on its own.
     */
    async syncState(): Promise<void> {
        const state = await this.asked('get_state');
        const data = (state.data ?? {}) as Snapshot;
        this.snapshot = { ...this.snapshot, ...data };
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * One question, answered with what came back or with nothing.
     *
     * A refusal from the far side rejects, and a refusal to one of these is
     * not a reason to abandon the rest: the interface still has to draw, with
     * whatever the session did answer. What the refusal said is not swallowed
     * -- it is reported through `refuse`, which the client shows.
     */
    private async asked(type: string): Promise<Record<string, unknown>> {
        try {
            return await this.link.send({ type });
        } catch (error) {
            this.refuse(`${type}: ${(error as Error).message}`);
            return {};
        }
    }

    /** Ask the far side for everything at once: done on attach, and after a reconnect. */
    async refresh(): Promise<void> {
        // What the far side can run, so a slash command typed here goes to the
        // side that owns it rather than always to the session.
        const commands = await this.asked('get_commands');
        const listed = (commands.data ?? {}) as { commands?: { name?: string }[] };
        if (Array.isArray(listed.commands)) {
            this.known = new Set(
                listed.commands
                    .map((command) => command.name)
                    .filter((name): name is string => typeof name === 'string'),
            );
        }

        const state = await this.asked('get_state');
        const data = (state.data ?? {}) as Snapshot;
        this.snapshot = { ...this.snapshot, ...data };

        // The levels this model has, because cycling through them is answered
        // from a keystroke: the interface reads the level it is given back and
        // has nowhere to put a promise.
        const levels = await this.asked('get_available_thinking_levels');
        const offered = (levels.data ?? {}) as { levels?: unknown };
        if (Array.isArray(offered.levels)) {
            this.levels = offered.levels.filter((level): level is string => typeof level === 'string');
        }

        const messages = await this.asked('get_messages');
        const carried = (messages.data ?? {}) as { messages?: AgentMessage[] };
        if (Array.isArray(carried.messages)) this.history = [...carried.messages];

        // What the far side would fork from, fetched here because the
        // interface asks for it from a keystroke and cannot wait.
        const forks = await this.asked('get_fork_messages');
        const points = (forks.data ?? {}) as { messages?: { entryId?: string; text?: string }[] };
        if (Array.isArray(points.messages)) {
            this.forkable = points.messages
                .filter((point): point is { entryId: string; text: string } =>
                    typeof point.entryId === 'string' && typeof point.text === 'string',
                )
                .map((point) => ({ entryId: point.entryId, text: point.text }));
        }
    }

    get state(): Readonly<Snapshot> {
        return this.snapshot;
    }

    get messages(): readonly AgentMessage[] {
        return this.history;
    }

    private known = new Set<string>();
    private levels: readonly string[] = [];

    /** The thinking levels the far side's model offers, as it last reported them. */
    get thinkingLevels(): readonly string[] {
        return this.levels;
    }

    /**
     * What this interface has just asked for, held until the far side confirms.
     *
     * pi reads the model back the moment it has set it -- the footer is drawn
     * from that read -- and the answer from another machine is a round trip
     * away. Without this the corner went on naming the model chosen before,
     * until something else caused a refresh.
     */
    assume(change: Partial<Snapshot>): void {
        this.snapshot = { ...this.snapshot, ...change };
    }

    /** The commands the far side reported: its extensions, prompt templates and skills. */
    get commandsThere(): ReadonlySet<string> {
        return this.known;
    }

    private lastTrouble: string | null = null;
    private forkable: { entryId: string; text: string }[] = [];
    private complaint: ((what: string) => void) | null = null;
    /** refusals from before anything was listening for them. */
    private readonly unsaid: string[] = [];

    /** The user messages the far side would fork from, as it last reported them. */
    get forkPoints(): { entryId: string; text: string }[] {
        return this.forkable;
    }

    /** Where to say that something cannot be done from here. */
    onRefusal(say: (what: string) => void): void {
        this.complaint = say;
        // Attaching asks the far side four questions before anything is
        // listening, and a refusal to one of those is the most interesting
        // thing that can happen at a connection: it was being dropped.
        while (this.unsaid.length > 0) say(this.unsaid.shift() as string);
    }

    refuse(what: string): void {
        if (this.complaint === null) {
            this.unsaid.push(what);
            return;
        }
        this.complaint(what);
    }

    /** What the far side refused with, if a turn ended in a refusal. */
    get trouble(): string | null {
        return this.lastTrouble;
    }
}

/** What the interface says about a prompt beyond its text. */
export interface PromptOptions {
    readonly streamingBehavior?: 'steer' | 'followUp';
    readonly images?: readonly unknown[];
}

/** The actions the interface can take, each one a command to the far side. */
export class RemoteActions {
    constructor(private readonly link: RpcLink) {}

    /**
     * A prompt, with what the interface said to do about a turn in progress.
     *
     * pi's interface does not stop you typing while the agent is answering: it
     * calls prompt with a streaming behaviour taken from the steering mode, and
     * the session queues or steers accordingly. Dropping that on the way across
     * turned every message typed mid-turn into `Agent is already processing`,
     * which is a refusal a local session never gives.
     */
    prompt(message: string, options: PromptOptions = {}): Promise<unknown> {
        return this.link.send({
            type: 'prompt',
            message,
            ...(options.streamingBehavior === undefined ? {} : { streamingBehavior: options.streamingBehavior }),
            ...(options.images === undefined ? {} : { images: options.images }),
        });
    }

    steer(message: string, images?: readonly unknown[]): Promise<unknown> {
        return this.link.send({ type: 'steer', message, ...(images === undefined ? {} : { images }) });
    }

    followUp(message: string, images?: readonly unknown[]): Promise<unknown> {
        return this.link.send({ type: 'follow_up', message, ...(images === undefined ? {} : { images }) });
    }

    abort(): Promise<unknown> {
        return this.link.send({ type: 'abort' });
    }

    /** End the session itself, rather than this interface onto it. */
    stopSession(): Promise<unknown> {
        return this.link.send({ type: 'rho_stop' });
    }

    compact(): Promise<unknown> {
        return this.link.send({ type: 'compact' });
    }

    setModel(provider: string, modelId: string): Promise<unknown> {
        return this.link.send({ type: 'set_model', provider, modelId });
    }

    setThinkingLevel(level: string): Promise<unknown> {
        return this.link.send({ type: 'set_thinking_level', level });
    }

    clearQueue(): Promise<unknown> {
        return this.link.send({ type: 'clear_queue' });
    }

    // The rest of what a session can be asked. Each of these used to run on
    // this machine instead, quietly: escape aborted a local session that was
    // not running while the far side carried on answering, and a bash command
    // typed into a remote session ran here.

    abortBash(): Promise<unknown> {
        return this.link.send({ type: 'abort_bash' });
    }

    abortRetry(): Promise<unknown> {
        return this.link.send({ type: 'abort_retry' });
    }

    bash(command: string): Promise<unknown> {
        return this.link.send({ type: 'bash', command });
    }

    cycleModel(): Promise<unknown> {
        return this.link.send({ type: 'cycle_model' });
    }

    cycleThinkingLevel(): Promise<unknown> {
        return this.link.send({ type: 'cycle_thinking_level' });
    }

    setSessionName(name: string): Promise<unknown> {
        return this.link.send({ type: 'set_session_name', name });
    }

    setSteeringMode(mode: string): Promise<unknown> {
        return this.link.send({ type: 'set_steering_mode', mode });
    }

    setFollowUpMode(mode: string): Promise<unknown> {
        return this.link.send({ type: 'set_follow_up_mode', mode });
    }

    setAutoCompaction(enabled: boolean): Promise<unknown> {
        return this.link.send({ type: 'set_auto_compaction', enabled });
    }

    setAutoRetry(enabled: boolean): Promise<unknown> {
        return this.link.send({ type: 'set_auto_retry', enabled });
    }

    sessionStats(): Promise<unknown> {
        return this.link.send({ type: 'get_session_stats' });
    }

    lastAssistantText(): Promise<unknown> {
        return this.link.send({ type: 'get_last_assistant_text' });
    }

    availableModels(): Promise<unknown> {
        return this.link.send({ type: 'get_available_models' });
    }

    availableThinkingLevels(): Promise<unknown> {
        return this.link.send({ type: 'get_available_thinking_levels' });
    }
}
