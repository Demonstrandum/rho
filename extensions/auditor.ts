// /audit: review the last assistant reply against the writer rules with a
// second model, outside this conversation, so the model that wrote the text is
// not the one grading it. the reviewer call lives in lib/audit.ts.
//
// on demand only. there is no per-message hook: a reviewer call on every reply
// would put a report next to every message and, with feedback reaching context,
// a correction into the history of every turn.
//
// the audited message is not replaced. what was said stays said, in the session
// tree, and the correction arrives as a later message.
import type {
    ExtensionCommandContext,
    EntryRenderOptions,
    ExtensionAPI,
    ExtensionContext,
    Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { config } from './lib/config';
import { formatDuration } from './spinner';
import { proseOf, runAudit, type AuditResult, type Finding } from './lib/audit';

const ENTRY_TYPE = 'rho-audit-report';
const WIDGET_KEY = 'rho-audit-spinner';

// ctx.modelRegistry only exposes complete(), not stream(), to extensions (see
// model-registry.d.ts), so there is no sanctioned way to show the reviewer's
// tokens as they generate. this animates instead, so the wait is visibly alive
// rather than a static status line: a spinner frame plus elapsed time, written
// as a widget (not setWorkingMessage/setWorkingIndicator, which the docs tie to
// an active agent turn and do not fire for a plain command).
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 90;

async function withSpinner<T>(ctx: ExtensionCommandContext, label: string, work: () => Promise<T>): Promise<T> {
    const start = Date.now();
    let frame = 0;
    const tick = (): void => {
        const glyph = ctx.ui.theme.fg('accent', SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
        ctx.ui.setWidget(WIDGET_KEY, [`${glyph} ${ctx.ui.theme.fg('dim', `${label} ${formatDuration(Date.now() - start)}`)}`]);
        frame++;
    };
    tick();
    const timer = setInterval(tick, SPINNER_INTERVAL_MS);
    try {
        return await work();
    } finally {
        clearInterval(timer);
        ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
}

type AuditEntry =
    | { readonly kind: 'findings'; readonly reviewer: string; readonly findings: readonly Finding[]; readonly cost: number }
    | { readonly kind: 'error'; readonly reviewer: string; readonly message: string };

function toEntry(result: AuditResult): AuditEntry {
    return result.kind === 'findings'
        ? { kind: 'findings', reviewer: result.reviewer, findings: result.findings, cost: result.cost }
        : { kind: 'error', reviewer: result.reviewer, message: result.message };
}

/**
 * the fed-back text. deliberately shorter than the transcript entry: the human
 * already saw each finding's location and prerequisite there, and the agent has
 * its own message in context already, so repeating the full quote a second
 * time here was pure duplication. rule, token, and repair are enough to act on.
 */
function feedbackText(findings: readonly Finding[]): string {
    const lines = findings.map((finding) => `- ${finding.rule} "${finding.token}": ${finding.repair}`).join('\n');
    return [
        'Writer-rule audit of your last message, from a separate reviewer model.',
        'These are corrections. Repair them in your next message. Do not apologise,',
        'do not explain the rules back, and do not describe what you changed.',
        '',
        lines,
    ].join('\n');
}

function renderReport(data: AuditEntry, theme: Theme, width: number): string[] {
    const dim = (s: string): string => theme.fg('dim', s);
    const out: string[] = [];

    if (data.kind === 'error') {
        out.push(`${theme.fg('warning', 'audit')} ${dim(data.reviewer)} ${theme.fg('warning', data.message)}`);
        return out.map((line) => truncateToWidth(line, width, dim('…')));
    }

    const count = data.findings.length;
    const summary = count === 0 ? 'clean' : `${count} finding${count === 1 ? '' : 's'}`;
    const cost = data.cost > 0 ? ` · $${data.cost.toFixed(3)}` : '';
    out.push(`${theme.fg('accent', 'audit')} ${dim(`${data.reviewer} · ${summary}${cost}`)}`);
    for (const finding of data.findings) {
        out.push(
            `${dim('·')} ${theme.fg('warning', finding.rule)} ${theme.fg('text', `"${finding.token}"`)} ${dim(finding.location)}`,
        );
        out.push(`  ${dim(finding.prerequisite)}`);
        out.push(`  ${theme.fg('success', finding.repair)}`);
    }
    return out.map((line) => truncateToWidth(line, width, dim('…')));
}

/** the most recent assistant message on the active branch that carries prose. */
function lastProse(ctx: ExtensionContext): string | undefined {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
        const prose = proseOf(entry.message.content);
        if (prose) return prose;
    }
    return undefined;
}

export default function (pi: ExtensionAPI) {
    pi.registerEntryRenderer<AuditEntry>(ENTRY_TYPE, (entry, _options: EntryRenderOptions, theme): Component | undefined => {
        const data = entry.data;
        if (!data) return undefined;
        return {
            invalidate() {},
            render(width: number): string[] {
                return renderReport(data, theme, width);
            },
        };
    });

    const SEND = 'send to the agent as-is';
    const EDIT = 'edit before sending';
    const DISCARD = 'discard';

    /**
     * a human decides whether a correction reaches the agent. the reviewer's
     * findings are a draft, not a verdict: `/audit` shows them and asks, offers
     * an editor to change the wording first, and only sends on that choice.
     */
    const offerToSend = async (ctx: ExtensionCommandContext, findings: readonly Finding[]): Promise<void> => {
        const choice = await ctx.ui.select(`send ${findings.length} finding(s) to the agent?`, [SEND, EDIT, DISCARD]);
        let text = feedbackText(findings);
        if (choice === EDIT) {
            const edited = await ctx.ui.editor('edit the note sent to the agent:', text);
            if (edited === undefined || edited.trim() === '') return;
            text = edited;
        } else if (choice !== SEND) {
            return;
        }
        try {
            // followUp + triggerTurn fires the reply now, since the command runs
            // while pi is idle; nextTurn would sit unseen until you happened to
            // send another message.
            pi.sendMessage(
                { customType: ENTRY_TYPE, content: text, display: false },
                { deliverAs: 'followUp', triggerTurn: true },
            );
        } catch {
            // the session this audit belonged to is gone by the time we sent.
        }
    };

    pi.registerCommand('audit', {
        description: 'audit the last response against the writer rules',
        handler: async (_args, ctx) => {
            const prose = lastProse(ctx);
            if (!prose) {
                ctx.ui.notify('no assistant prose on this branch to audit', 'warning');
                return;
            }

            const result = await withSpinner(ctx, `auditing with ${config.audit.model}`, () => runAudit(ctx, prose));

            const destination = config.audit.feedback;
            if (destination !== 'context') pi.appendEntry<AuditEntry>(ENTRY_TYPE, toEntry(result));

            if (result.kind === 'error') {
                ctx.ui.notify(result.message, 'error');
                return;
            }
            if (result.findings.length === 0) {
                ctx.ui.notify('clean: no writer-rule findings', 'info');
                return;
            }
            if (destination !== 'transcript') await offerToSend(ctx, result.findings);
        },
    });
}
