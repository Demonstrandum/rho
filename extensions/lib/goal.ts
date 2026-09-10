// the goal loop's judge: one constrained call to a second model that reads a
// rendered transcript and answers whether a completion condition holds.
//
// the point of the split is that the model doing the work does not decide when
// the work is done. an agent that has just spent twenty turns on a migration is
// the worst available judge of whether the migration is finished, so the
// verdict comes from a model that has no stake in the answer and no memory of
// having tried. the judge gets no tools either: it can only rule on what the
// agent has already put in the transcript, which forces a condition to be
// something the agent must demonstrate (run the tests, print the exit code)
// rather than something it can assert.
//
// the unmet verdict carries a reason, and that reason is fed back as the next
// turn's input. the loop therefore carries a difference between the current
// state and the condition, rather than re-sending the original prompt.
//
// in a subdirectory so extension auto-discovery (top-level *.ts only) does not
// load it as an extension.
import { Type } from 'typebox';
import type { Api, Model, Tool, ToolCall } from '@earendil-works/pi-ai';
import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { config } from './config';
import { forcedToolChoice, resolveReviewer } from './audit';

const TOOL_NAME = 'report_verdict';

/** what the judge answers through: a verdict is parsed, never read as prose. */
const verdictTool: Tool = {
    name: TOOL_NAME,
    description:
        'Report whether the stopping condition is satisfied. Call this tool exactly once and write no prose outside it.',
    parameters: Type.Object({
        ok: Type.Boolean({ description: 'true only when the transcript shows the condition is satisfied' }),
        reason: Type.String({
            description:
                'when ok, the transcript evidence that satisfies the condition, quoted; when not ok, what is missing or what blocks it',
        }),
        impossible: Type.Optional(
            Type.Boolean({
                description: 'true when the condition can never be satisfied in this session (only read when ok is false)',
            }),
        ),
    }),
};

const systemPrompt = [
    'You judge a stopping condition for a coding agent. Read the transcript, then decide whether the condition is satisfied.',
    `Answer with one ${TOOL_NAME} call and no prose.`,
    'Quote specific text from the transcript in your reason whenever you can.',
    'You have no tools. You cannot run a command or read a file, so the transcript is the only evidence there is.',
    'When the transcript holds no clear evidence that the condition is satisfied, answer ok: false with the reason "insufficient evidence in transcript".',
    'Set impossible only when the condition can never be satisfied in this session: it contradicts itself, it needs a resource or a capability that is not available, or the agent has tried, exhausted the reasonable approaches, and stated that it cannot be done.',
    "The agent's own claim that the goal is impossible is evidence, not proof; confirm it against the transcript rather than deferring to it.",
    'Slow progress is not impossibility. When in doubt, answer ok: false and leave impossible unset.',
].join('\n');

export interface ActiveGoal {
    readonly condition: string;
    /** ms epoch of the moment the goal started running, reset by a resume. */
    readonly setAt: number;
    /** evaluations completed for this goal. */
    readonly iterations: number;
    /** consecutive unmet verdicts, reset by a met verdict or by the block cap. */
    readonly blocks: number;
    readonly lastReason?: string;
}

export type Verdict =
    | { readonly kind: 'met'; readonly reason: string }
    | { readonly kind: 'unmet'; readonly reason: string }
    | { readonly kind: 'impossible'; readonly reason: string }
    | { readonly kind: 'error'; readonly message: string };

/** what evaluate needs from an extension ctx, and nothing more. */
export type GoalContext = Pick<ExtensionContext, 'model' | 'modelRegistry' | 'signal'>;

export function parseActiveGoal(raw: unknown): ActiveGoal | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.condition !== 'string' || value.condition.trim() === '') return null;
    if (typeof value.setAt !== 'number' || !Number.isFinite(value.setAt)) return null;
    if (typeof value.iterations !== 'number' || !Number.isInteger(value.iterations)) return null;
    if (typeof value.blocks !== 'number' || !Number.isInteger(value.blocks)) return null;
    if (value.lastReason !== undefined && typeof value.lastReason !== 'string') return null;
    return {
        condition: value.condition,
        setAt: value.setAt,
        iterations: value.iterations,
        blocks: value.blocks,
        ...(value.lastReason !== undefined && { lastReason: value.lastReason }),
    };
}

/**
 * the failures that make continuing pointless: retrying them produces the same
 * error until a human intervenes, so the goal is cleared rather than left to
 * burn turns against the block cap. every other failure, rate limits and
 * overloaded servers included, leaves the goal set.
 */
export type FatalFailure = 'an authentication failure' | 'an exhausted balance' | 'a context overflow' | 'an unavailable model';

const FATAL_PATTERNS: ReadonlyArray<readonly [RegExp, FatalFailure]> = [
    [/\b(401|403|unauthori[sz]ed|forbidden|invalid api key|authentication|oauth|expired token)\b/i, 'an authentication failure'],
    [/\b(credit balance|insufficient (?:credit|funds|balance)|payment required|quota exceeded|billing)\b/i, 'an exhausted balance'],
    [/\b(context (?:window|length) exceeded|too many tokens|prompt is too long|maximum context)\b/i, 'a context overflow'],
    [/\b(model not found|unknown model|model .* (?:unavailable|not available)|no such model|404)\b/i, 'an unavailable model'],
];

export function classifyFailure(message: string | undefined): FatalFailure | null {
    if (message === undefined) return null;
    for (const [pattern, failure] of FATAL_PATTERNS) {
        if (pattern.test(message)) return failure;
    }
    return null;
}

/** per-block cap, so one enormous tool result cannot crowd out every other turn. */
const BLOCK_CHARS = 4000;

function clip(text: string, limit = BLOCK_CHARS): string {
    const trimmed = text.trim();
    return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n[...${trimmed.length - limit} characters omitted]`;
}

/** one entry as the judge sees it, or null for an entry that carries no evidence. */
function renderEntry(entry: SessionEntry): string | null {
    if (entry.type === 'custom_message') {
        const content = typeof entry.content === 'string'
            ? entry.content
            : entry.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
        return content.trim() === '' ? null : `<note>\n${clip(content)}\n</note>`;
    }
    if (entry.type !== 'message') return null;
    const message = entry.message;

    switch (message.role) {
        case 'user': {
            const text = typeof message.content === 'string'
                ? message.content
                : message.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
            return text.trim() === '' ? null : `<user>\n${clip(text)}\n</user>`;
        }
        case 'assistant': {
            // thinking is left out: it is what the agent considered, not what
            // it established, and a condition judged from deliberation rather
            // than from output is the self-assessment this design removes.
            const parts = message.content.flatMap((part) => {
                if (part.type === 'text') return [part.text];
                if (part.type === 'toolCall') return [`[calls ${part.name} ${clip(JSON.stringify(part.arguments), 300)}]`];
                return [];
            });
            return parts.length === 0 ? null : `<agent>\n${clip(parts.join('\n'))}\n</agent>`;
        }
        case 'toolResult': {
            const output = message.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
            return `<result tool="${message.toolName}">\n${clip(output)}\n</result>`;
        }
        case 'bashExecution': {
            const code = message.exitCode === undefined ? 'none' : String(message.exitCode);
            return `<shell command="${clip(message.command, 200)}" exit="${code}">\n${clip(message.output)}\n</shell>`;
        }
        case 'custom': {
            const text = typeof message.content === 'string'
                ? message.content
                : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
            return text.trim() === '' ? null : `<note>\n${clip(text)}\n</note>`;
        }
        case 'branchSummary':
        case 'compactionSummary':
            return `<summary>\n${clip(message.summary)}\n</summary>`;
    }
}

/**
 * the transcript, newest entries kept. the budget is in characters because that
 * is what can be measured here without a tokeniser; four characters to a token
 * is the usual approximation and errs toward sending less.
 */
export function renderTranscript(entries: readonly SessionEntry[], budgetChars: number): string {
    const blocks = entries.flatMap((entry) => {
        const rendered = renderEntry(entry);
        return rendered === null ? [] : [rendered];
    });

    const kept: string[] = [];
    let size = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (kept.length > 0 && size + block.length > budgetChars) break;
        kept.unshift(block);
        size += block.length;
    }

    const dropped = blocks.length - kept.length;
    if (dropped === 0) return kept.join('\n\n');
    return [
        `[The first ${dropped} entries of this conversation are omitted to fit your context window.`,
        'Judge the condition against the transcript below; if the evidence you need may be in the omitted part,',
        'answer ok: false with the reason "insufficient evidence in transcript".]',
        '',
        kept.join('\n\n'),
    ].join('\n');
}

/** the character budget for one evaluation, from the judge's own context window. */
export function transcriptBudget(model: Model<Api>): number {
    return Math.floor(model.contextWindow * config.goal.transcriptFraction * 4);
}

/** abort on the configured timeout, or as soon as the turn itself aborts. */
function deadline(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const relay = () => controller.abort();
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener('abort', relay, { once: true });
    return {
        signal: controller.signal,
        done() {
            clearTimeout(timer);
            parent?.removeEventListener('abort', relay);
        },
    };
}

interface VerdictArguments {
    readonly ok: boolean;
    readonly reason: string;
    readonly impossible?: boolean;
}

function parseVerdictArguments(args: unknown): VerdictArguments | undefined {
    if (typeof args !== 'object' || args === null) return undefined;
    const value = args as Record<string, unknown>;
    if (typeof value.ok !== 'boolean') return undefined;
    if (typeof value.reason !== 'string') return undefined;
    if (value.impossible !== undefined && typeof value.impossible !== 'boolean') return undefined;
    return { ok: value.ok, reason: value.reason, ...(value.impossible !== undefined && { impossible: value.impossible }) };
}

export interface Evaluation {
    readonly verdict: Verdict;
    /** the judge, resolved rather than as configured. */
    readonly judge: string;
    readonly cost: number;
}

export async function evaluate(
    ctx: GoalContext,
    condition: string,
    entries: readonly SessionEntry[],
): Promise<Evaluation> {
    const resolved = resolveReviewer(config.goal.model, ctx.model, ctx.modelRegistry, 'goal.model');
    if (!resolved.ok) {
        return { verdict: { kind: 'error', message: resolved.message }, judge: config.goal.model, cost: 0 };
    }

    const judge = `${resolved.model.provider}/${resolved.model.id}`;
    const transcript = renderTranscript(entries, transcriptBudget(resolved.model));
    const toolChoice = forcedToolChoice(resolved.model.api, TOOL_NAME);
    const timeout = deadline(ctx.signal, config.goal.timeoutMs);
    try {
        const response = await ctx.modelRegistry.complete(
            resolved.model,
            {
                systemPrompt,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: [
                                    `<transcript>\n${transcript}\n</transcript>`,
                                    '',
                                    'Has this stopping condition been satisfied? Judge on transcript evidence only.',
                                    `Condition: ${condition}`,
                                ].join('\n'),
                            },
                        ],
                        timestamp: Date.now(),
                    },
                ],
                tools: [verdictTool],
            },
            // toolChoice is an api-specific option, and the model's api is only
            // known at runtime, so the shape cannot be proven per-provider here.
            { maxTokens: 1024, signal: timeout.signal, ...(toolChoice && { toolChoice }) } as Parameters<
                GoalContext['modelRegistry']['complete']
            >[2],
        );

        const cost = response.usage?.cost?.total ?? 0;
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
            return {
                verdict: {
                    kind: 'error',
                    message: `judge ${response.stopReason}: ${response.errorMessage ?? 'no detail'}`,
                },
                judge,
                cost,
            };
        }

        const call = response.content.find(
            (part): part is ToolCall => part.type === 'toolCall' && part.name === TOOL_NAME,
        );
        if (!call) return { verdict: { kind: 'error', message: `judge did not call ${TOOL_NAME}` }, judge, cost };

        const parsed = parseVerdictArguments(call.arguments);
        if (!parsed) {
            return { verdict: { kind: 'error', message: `judge sent malformed ${TOOL_NAME} arguments` }, judge, cost };
        }

        const reason = parsed.reason.trim() === '' ? 'no reason given' : parsed.reason.trim();
        if (parsed.ok) return { verdict: { kind: 'met', reason }, judge, cost };
        if (parsed.impossible === true) return { verdict: { kind: 'impossible', reason }, judge, cost };
        return { verdict: { kind: 'unmet', reason }, judge, cost };
    } catch (e) {
        return { verdict: { kind: 'error', message: `judge call failed: ${(e as Error).message}` }, judge, cost: 0 };
    } finally {
        timeout.done();
    }
}

/**
 * the message that starts the loop. the condition is the directive: asking the
 * user what to do next would hand control back on the first turn, which is the
 * thing a goal exists to stop.
 */
export function directiveText(condition: string): string {
    return [
        `A stopping condition is now active for this session: "${condition}".`,
        'Acknowledge it in one line, then start working toward it immediately.',
        'Treat the condition as your directive: do not ask what to do next, and do not stop to report progress unless the work needs a decision only the user can make.',
        'After every turn a separate model reads this conversation and judges whether the condition holds, so put the evidence in your output: run the check and show its result.',
        'The condition clears itself once it is met, so do not tell the user to clear it.',
    ].join('\n');
}

/** the fed-back unmet verdict: a work instruction rather than a retry. */
export function feedbackText(condition: string, reason: string): string {
    return [
        'The stopping condition for this session is not met yet.',
        `Condition: ${condition}`,
        `A separate model read this conversation and reported: ${reason}`,
        'Keep working toward the condition. Address what the reason names, and surface the evidence that settles it.',
    ].join('\n');
}
