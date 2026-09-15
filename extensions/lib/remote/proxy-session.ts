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
                const message = (event as { message?: AgentMessage }).message;
                if (message !== undefined) this.history.push(message);
                // An assistant message that carries a refusal instead of an
                // answer reads as the model having nothing to say: the token
                // expiring on the far side looked exactly like silence. The
                // trouble is kept where a client can ask for it.
                const trouble = (message as { errorMessage?: string } | undefined)?.errorMessage;
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

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Ask the far side for everything at once: done on attach, and after a reconnect. */
    async refresh(): Promise<void> {
        const state = await this.link.send({ type: 'get_state' });
        const data = (state.data ?? {}) as Snapshot;
        this.snapshot = { ...this.snapshot, ...data };
        const messages = await this.link.send({ type: 'get_messages' });
        const carried = (messages.data ?? {}) as { messages?: AgentMessage[] };
        if (Array.isArray(carried.messages)) this.history = [...carried.messages];

        // What the far side would fork from, fetched here because the
        // interface asks for it from a keystroke and cannot wait.
        const forks = await this.link
            .send({ type: 'get_fork_messages' })
            .catch(() => ({}) as Record<string, unknown>);
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

    private lastTrouble: string | null = null;
    private forkable: { entryId: string; text: string }[] = [];
    private complaint: ((what: string) => void) | null = null;

    /** The user messages the far side would fork from, as it last reported them. */
    get forkPoints(): { entryId: string; text: string }[] {
        return this.forkable;
    }

    /** Where to say that something cannot be done from here. */
    onRefusal(say: (what: string) => void): void {
        this.complaint = say;
    }

    refuse(what: string): void {
        this.complaint?.(what);
    }

    /** What the far side refused with, if a turn ended in a refusal. */
    get trouble(): string | null {
        return this.lastTrouble;
    }
}

/** The actions the interface can take, each one a command to the far side. */
export class RemoteActions {
    constructor(private readonly link: RpcLink) {}

    prompt(message: string): Promise<unknown> {
        return this.link.send({ type: 'prompt', message });
    }

    steer(message: string): Promise<unknown> {
        return this.link.send({ type: 'steer', message });
    }

    followUp(message: string): Promise<unknown> {
        return this.link.send({ type: 'follow_up', message });
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
