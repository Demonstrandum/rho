// out-of-band prose audit: one constrained call to a second model, which reads
// a finalized assistant message and reports writer-rule violations.
//
// the reviewer never joins the session. it gets its own system prompt (the
// writer rules plus the auditor skill), one user message holding the text under
// review, and a single forced tool it must answer through, so the result is
// structured rather than prose. ctx.modelRegistry.complete resolves auth,
// headers, and baseUrl itself, so nothing here touches credentials.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Type, type Static } from 'typebox';
import type { Api, AssistantMessage, Model, Tool, ToolCall } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { config } from './config';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TOOL_NAME = 'report_findings';

const findingSchema = Type.Object({
    location: Type.String({
        description: 'where in the text: quote the phrase or the opening of the sentence',
    }),
    token: Type.String({ description: 'the exact word or symbol at fault' }),
    rule: Type.String({ description: 'the rule number, e.g. 2.(i)' }),
    prerequisite: Type.String({
        description: 'what a reader cannot answer without it, in one clause',
    }),
    repair: Type.String({ description: 'the minimal repair, in one clause' }),
});

const findingsTool: Tool = {
    name: TOOL_NAME,
    description:
        'Report every writer-rule violation in the text under review. Call this tool exactly once. An empty findings array is a valid result and means the text is clean.',
    parameters: Type.Object({
        findings: Type.Array(findingSchema, {
            description: 'One entry per violation, in rule order. Empty when there is nothing to report.',
        }),
    }),
};

export type Finding = Static<typeof findingSchema>;

export type AuditResult =
    | {
        readonly kind: 'findings';
        /** which model reviewed, resolved rather than as configured. */
        readonly reviewer: string;
        readonly findings: readonly Finding[];
        readonly cost: number;
    }
    | { readonly kind: 'error'; readonly reviewer: string; readonly message: string };

/** what runAudit needs from an extension ctx, and nothing more. */
export type AuditContext = Pick<ExtensionContext, 'model' | 'modelRegistry' | 'signal'>;

/** the text blocks of an assistant message, which is all the reviewer reads. */
export function proseOf(content: AssistantMessage['content'] | string): string {
    if (typeof content === 'string') return content.trim();
    return content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n\n')
        .trim();
}

function read(...parts: string[]): string {
    return readFileSync(join(root, ...parts), 'utf8');
}

/** drop a leading `---` yaml block, which is metadata for pi rather than prose. */
function stripFrontmatter(text: string): string {
    const match = text.match(/^---\n[\s\S]*?\n---\n/);
    return match ? text.slice(match[0].length) : text;
}

const skillBody = stripFrontmatter(read('skills', 'auditor', 'SKILL.md'));

// the skill's own Checks section is the sole source of truth for which rule
// numbers this review may cite; extracted rather than duplicated, so an edit
// to the skill's checklist changes what parseFindings accepts without a
// second edit here.
const normalizeRule = (rule: string): string => rule.replace(/\s+/g, '');
const VALID_RULES = new Set((skillBody.match(/^\d+\.\([ivx]+\)/gm) ?? []).map(normalizeRule));

// built once at import: the prefix is identical on every call, so it caches at
// the provider.
const systemPrompt = [
    read('system', 'writer-rules.md'),
    skillBody,
    `## Audience\n\nThe reader is ${config.audit.audience}.`,
    `## Output\n\nCall the ${TOOL_NAME} tool exactly once. Do not write prose outside the tool call.`,
].join('\n\n');

/**
 * how to force the single tool call. each api spells this differently, and an
 * api pi knows nothing about gets no forcing at all: the tool is still offered,
 * and a model that answers in prose is reported as an error rather than parsed.
 */
type ForcedToolChoice = 'any' | 'required' | { readonly type: 'tool'; readonly name: string };

function forcedToolChoice(api: Api): ForcedToolChoice | undefined {
    switch (api) {
        case 'anthropic-messages':
        case 'bedrock-converse-stream':
            return { type: 'tool', name: TOOL_NAME };
        case 'google-generative-ai':
        case 'google-vertex':
            return 'any';
        case 'openai-completions':
        case 'openai-responses':
        case 'azure-openai-responses':
        case 'openai-codex-responses':
        case 'mistral-conversations':
            return 'required';
        default:
            return undefined;
    }
}

type ModelLookup = Pick<AuditContext['modelRegistry'], 'find'>;

/**
 * `provider/id` splits at the first slash only: an id can itself contain one
 * (openrouter's `anthropic/claude-haiku-4.5`). `current` means the session model.
 */
export function resolveReviewer(
    spec: string,
    sessionModel: Model<Api> | undefined,
    registry: ModelLookup,
): { readonly ok: true; readonly model: Model<Api> } | { readonly ok: false; readonly message: string } {
    if (spec === 'current') {
        return sessionModel
            ? { ok: true, model: sessionModel }
            : { ok: false, message: 'no session model to review with' };
    }
    const slash = spec.indexOf('/');
    if (slash <= 0 || slash === spec.length - 1) {
        return { ok: false, message: `audit.model must be "provider/id" or "current", got "${spec}"` };
    }
    const model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    return model ? { ok: true, model } : { ok: false, message: `reviewer model ${spec} is unavailable` };
}

function isFinding(value: unknown): value is Finding {
    if (typeof value !== 'object' || value === null) return false;
    const keys: ReadonlyArray<keyof Finding> = ['location', 'token', 'rule', 'prerequisite', 'repair'];
    return keys.every((key) => typeof (value as Record<string, unknown>)[key] === 'string');
}

export function parseFindings(args: unknown): readonly Finding[] | undefined {
    if (typeof args !== 'object' || args === null) return undefined;
    const findings = (args as { findings?: unknown }).findings;
    if (!Array.isArray(findings)) return undefined;
    if (!findings.every(isFinding)) return undefined;
    // a rule number outside the skill's own Checks list is out of scope for
    // this skill by its own "Numbers absent from this list are writer-only"
    // rule; drop it rather than surface a citation the skill never licensed.
    return findings.filter((finding) => VALID_RULES.has(normalizeRule(finding.rule)));
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

export async function runAudit(ctx: AuditContext, text: string): Promise<AuditResult> {
    const resolved = resolveReviewer(config.audit.model, ctx.model, ctx.modelRegistry);
    if (!resolved.ok) return { kind: 'error', reviewer: config.audit.model, message: resolved.message };

    const reviewer = `${resolved.model.provider}/${resolved.model.id}`;
    const toolChoice = forcedToolChoice(resolved.model.api);
    const timeout = deadline(ctx.signal, config.audit.timeoutMs);
    try {
        const response = await ctx.modelRegistry.complete(
            resolved.model,
            {
                systemPrompt,
                messages: [
                    {
                        role: 'user',
                        content: [{ type: 'text', text: `<text_under_review>\n${text}\n</text_under_review>` }],
                        timestamp: Date.now(),
                    },
                ],
                tools: [findingsTool],
            },
            // toolChoice is an api-specific option, and the model's api is only
            // known at runtime, so the shape cannot be proven per-provider here.
            { maxTokens: 4096, signal: timeout.signal, ...(toolChoice && { toolChoice }) } as Parameters<
                AuditContext['modelRegistry']['complete']
            >[2],
        );

        const cost = response.usage?.cost?.total ?? 0;
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
            return {
                kind: 'error',
                reviewer,
                message: `reviewer ${response.stopReason}: ${response.errorMessage ?? 'no detail'}`,
            };
        }

        const call = response.content.find(
            (part): part is ToolCall => part.type === 'toolCall' && part.name === TOOL_NAME,
        );
        if (!call) return { kind: 'error', reviewer, message: `reviewer did not call ${TOOL_NAME}` };

        const findings = parseFindings(call.arguments);
        if (!findings) {
            return { kind: 'error', reviewer, message: `reviewer sent malformed ${TOOL_NAME} arguments` };
        }

        return { kind: 'findings', reviewer, findings, cost };
    } catch (e) {
        return { kind: 'error', reviewer, message: `reviewer call failed: ${(e as Error).message}` };
    } finally {
        timeout.done();
    }
}

/** one finding as a line, shared by the transcript renderer and the fed-back text. */
export function formatFinding(finding: Finding): string {
    return `${finding.location}, "${finding.token}": ${finding.rule}. ${finding.prerequisite} ${finding.repair}`;
}
