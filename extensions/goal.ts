// /goal: a stopping condition for the session. after every turn a second model
// reads the conversation and answers whether the condition holds; while it does
// not, the turn restarts with the reason as its input.
//
// pi has no stop hook, so the loop hangs off `agent_settled`, which fires only
// once pi has decided it will not continue on its own (no retry, no
// compaction, no queued follow-up). that is the same position a stop hook
// occupies: the last moment before control returns to the human.
//
// four guards keep it finite. an unmet verdict is counted, and `[goal]
// block-cap` consecutive unmet verdicts hand control back with the goal still
// set. an aborted turn (escape) pauses the loop until the next message, since
// the abort was the human taking the session back. a turn that failed on
// something a human has to fix (auth, balance, context overflow, missing model)
// clears the goal, because retrying it produces the same error. and the judge
// may itself rule the condition impossible, which clears the goal with a
// reason.
//
// the judge and its prompt live in lib/goal.ts; `[goal]` in rho.toml configures
// both halves.
import type {
    EntryRenderOptions,
    ExtensionAPI,
    ExtensionContext,
    Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { config } from './lib/config';
import { PersistedState } from './lib/state-store';
import { withSpinner } from './lib/widget-spinner';
import { loadMaxims } from './spinner';
import { duration as formatDuration } from './lib/text';
import {
    chooseMessage,
    classifyFailure,
    directiveText,
    evaluate,
    feedbackText,
    parseActiveGoal,
    type ActiveGoal,
    type Verdict,
} from './lib/goal';

const ENTRY_TYPE = 'rho-goal';
const STATE_NAME = 'goal';
const STATUS_ID = 'rho-goal';
const WIDGET_KEY = 'rho-goal-spinner';

/** every word that means "stop this goal now", as claude code accepts them. */
const CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

type GoalEntry =
    | { readonly kind: 'set'; readonly condition: string }
    | { readonly kind: 'cleared'; readonly condition: string }
    | { readonly kind: 'status'; readonly goal: ActiveGoal | null; readonly tokens: number; readonly cost: number }
    | {
        readonly kind: 'verdict';
        readonly verdict: Verdict;
        readonly judge: string;
        readonly iterations: number;
        readonly cost: number;
    };

/** what a goal has spent: the assistant messages on this branch since it started. */
function spendSince(ctx: ExtensionContext, since: number): { tokens: number; cost: number } {
    let tokens = 0;
    let cost = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
        if (entry.message.timestamp < since) continue;
        tokens += entry.message.usage?.totalTokens ?? 0;
        cost += entry.message.usage?.cost?.total ?? 0;
    }
    return { tokens, cost };
}

function renderEntry(data: GoalEntry, theme: Theme, width: number): string[] {
    const dim = (s: string): string => theme.fg('dim', s);
    const out: string[] = [];

    switch (data.kind) {
        case 'set':
            out.push(`${theme.fg('accent', '◎ goal')} ${theme.fg('text', data.condition)}`);
            break;
        case 'cleared':
            out.push(`${theme.fg('accent', '◎ goal cleared')} ${dim(data.condition)}`);
            break;
        case 'status': {
            if (data.goal === null) {
                out.push(`${theme.fg('accent', '◎ goal')} ${dim('none set')}`);
                break;
            }
            const { condition, setAt, iterations, lastReason } = data.goal;
            out.push(`${theme.fg('accent', '◎ goal')} ${theme.fg('text', condition)}`);
            const spend = data.cost > 0 ? ` · $${data.cost.toFixed(3)}` : '';
            out.push(
                `  ${dim(`${formatDuration(Date.now() - setAt)} · ${iterations} evaluated · ${data.tokens} tokens${spend}`)}`,
            );
            if (lastReason !== undefined) out.push(`  ${dim(`last check: ${lastReason}`)}`);
            break;
        }
        case 'verdict': {
            const { verdict } = data;
            const cost = data.cost > 0 ? ` · $${data.cost.toFixed(3)}` : '';
            const label = dim(`${data.judge} · check ${data.iterations}${cost}`);
            if (verdict.kind === 'error') {
                out.push(`${theme.fg('warning', '◎ goal')} ${label}`);
                out.push(`  ${theme.fg('warning', verdict.message)}`);
                break;
            }
            const colour = verdict.kind === 'met' ? 'success' : verdict.kind === 'impossible' ? 'warning' : 'accent';
            out.push(`${theme.fg(colour, `◎ ${verdict.kind}`)} ${label}`);
            out.push(`  ${dim(verdict.reason)}`);
            break;
        }
    }

    return out.map((line) => truncateToWidth(line, width, dim('…')));
}

export default function (pi: ExtensionAPI) {
    let goal: ActiveGoal | null = null;
    let store: PersistedState<ActiveGoal> | null = null;
    // one evaluation at a time. a second agent_settled can arrive while the
    // judge is still answering (another extension started a run), and two
    // judges racing would double-count blocks and send two feedback messages.
    let evaluating = false;
    // how the last assistant message ended, which is how an abort and a fatal
    // api failure are told apart from a normal turn.
    let lastStop: string | undefined;
    let lastError: string | undefined;

    const save = (): void => {
        if (goal === null) store?.clear();
        else store?.write(goal);
    };

    const showStatus = (ctx: ExtensionContext): void => {
        if (goal === null) {
            ctx.ui.setStatus(STATUS_ID, undefined);
            return;
        }
        const turns = goal.iterations > 0 ? ` ${goal.iterations}` : '';
        ctx.ui.setStatus(STATUS_ID, `◎ goal${turns} ${formatDuration(Date.now() - goal.setAt)}`);
    };

    const set = (ctx: ExtensionContext, condition: string): void => {
        goal = { condition, setAt: Date.now(), iterations: 0, blocks: 0 };
        save();
        pi.appendEntry<GoalEntry>(ENTRY_TYPE, { kind: 'set', condition });
        showStatus(ctx);
        // followUp + triggerTurn starts the work now. the condition itself is
        // the prompt, so nothing else has to be typed to begin.
        pi.sendMessage(
            { customType: ENTRY_TYPE, content: directiveText(condition), display: false },
            { deliverAs: 'followUp', triggerTurn: true },
        );
    };

    const clear = (ctx: ExtensionContext, note?: string): string | null => {
        if (goal === null) return null;
        const { condition } = goal;
        goal = null;
        save();
        pi.appendEntry<GoalEntry>(ENTRY_TYPE, { kind: 'cleared', condition });
        showStatus(ctx);
        if (note !== undefined) ctx.ui.notify(note, 'warning');
        return condition;
    };

    pi.registerEntryRenderer<GoalEntry>(ENTRY_TYPE, (entry, _options: EntryRenderOptions, theme): Component | undefined => {
        const data = entry.data;
        if (!data) return undefined;
        return {
            invalidate() {},
            render(width: number): string[] {
                return renderEntry(data, theme, width);
            },
        };
    });

    pi.on('session_start', async (_event, ctx) => {
        store = config.goal.persist
            ? PersistedState.open(
                { name: STATE_NAME, scope: 'session', parse: parseActiveGoal },
                { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
            )
            : null;
        const restored = store?.read() ?? null;
        // the condition survives; the timer, the turn count and the block count
        // do not. they measure this run of the loop, not the condition.
        goal = restored === null ? null : { ...restored, setAt: Date.now(), iterations: 0, blocks: 0 };
        save();
        showStatus(ctx);
    });

    pi.on('message_end', async (event, _ctx) => {
        if (event.message.role !== 'assistant') return;
        lastStop = event.message.stopReason;
        lastError = event.message.errorMessage;
    });

    pi.on('agent_settled', async (_event, ctx) => {
        if (goal === null || evaluating) return;

        if (lastStop === 'aborted') {
            ctx.ui.notify('goal paused after the abort; it resumes on your next message', 'info');
            return;
        }
        if (lastStop === 'error') {
            const fatal = classifyFailure(lastError);
            if (fatal !== null) {
                clear(ctx, `goal cleared after ${fatal}. fix the cause, then run /goal again to continue`);
                return;
            }
            // a transient failure (rate limit, overloaded server) leaves the
            // goal set and evaluates nothing: there is no new evidence to read.
            return;
        }
        // a queued message is the human steering. let it land first; the next
        // settle evaluates against a transcript that includes it.
        if (ctx.hasPendingMessages()) return;

        evaluating = true;
        let result: Awaited<ReturnType<typeof evaluate>>;
        const condition = goal.condition;
        try {
            // the judge runs between turns, where pi draws nothing, so the wait
            // gets a spinner of its own rather than looking like a finished
            // session that has stopped answering.
            result = await withSpinner(ctx, WIDGET_KEY, chooseMessage(config.goal.checkingMessages, loadMaxims()), () =>
                evaluate(ctx, condition, ctx.sessionManager.buildContextEntries()),
            );
        } finally {
            evaluating = false;
        }

        // the goal can have been cleared by hand while the judge was answering.
        if (goal === null) return;

        const iterations = goal.iterations + 1;
        const { verdict } = result;
        pi.appendEntry<GoalEntry>(ENTRY_TYPE, {
            kind: 'verdict',
            verdict,
            judge: result.judge,
            iterations,
            cost: result.cost,
        });

        if (verdict.kind === 'error') {
            // an unreadable verdict is not a verdict. the turn ends, the goal
            // stays set, and the next turn evaluates again.
            goal = { ...goal, iterations };
            save();
            showStatus(ctx);
            return;
        }

        if (verdict.kind === 'met' || verdict.kind === 'impossible') {
            goal = null;
            save();
            showStatus(ctx);
            return;
        }

        const blocks = goal.blocks + 1;
        if (blocks > config.goal.blockCap) {
            // hand control back rather than spend the session. the counter
            // resets, so one message resumes the loop.
            goal = { ...goal, iterations, blocks: 0, lastReason: verdict.reason };
            save();
            showStatus(ctx);
            ctx.ui.notify(
                `goal not met after ${config.goal.blockCap} consecutive checks; paused, and it resumes on your next message`,
                'warning',
            );
            return;
        }

        goal = { ...goal, iterations, blocks, lastReason: verdict.reason };
        save();
        showStatus(ctx);
        pi.sendMessage(
            { customType: ENTRY_TYPE, content: feedbackText(goal.condition, verdict.reason), display: false },
            { deliverAs: 'followUp', triggerTurn: true },
        );
    });

    pi.registerCommand('goal', {
        description: 'work until a condition holds, judged by a second model after each turn',
        getArgumentCompletions: (prefix: string) => {
            const items = [{ value: 'clear', label: 'clear the active goal' }];
            const matching = items.filter((item) => item.value.startsWith(prefix));
            return matching.length > 0 ? matching : null;
        },
        handler: async (args, ctx) => {
            const text = args.trim();

            if (text === '') {
                const spend = goal === null ? { tokens: 0, cost: 0 } : spendSince(ctx, goal.setAt);
                pi.appendEntry<GoalEntry>(ENTRY_TYPE, { kind: 'status', goal, ...spend });
                return;
            }

            if (CLEAR_WORDS.has(text.toLowerCase())) {
                if (clear(ctx) === null) ctx.ui.notify('no goal set', 'info');
                return;
            }

            if (text.length > config.goal.maxChars) {
                ctx.ui.notify(`a condition is limited to ${config.goal.maxChars} characters (got ${text.length})`, 'error');
                return;
            }

            set(ctx, text);
        },
    });
}
