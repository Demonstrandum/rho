// custom footer: a faithful copy of pi's built-in footer, with the token
// arrows swapped for different glyphs. pi does not expose the arrow chars on
// their own, so the whole footer has to be replaced to change them.
//
// edit ARROW_IN / ARROW_OUT below. everything else mirrors the built-in.

import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const ARROW_IN = '▲';
const ARROW_OUT = '▽';

// pi defaults auto-compaction on; flip if you disable it in settings.
const SHOW_AUTO = true;

function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
    if (!home) return cwd;
    const rel = relative(resolve(home), resolve(cwd));
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!inside) return cwd;
    return rel === '' ? '~' : `~${sep}${rel}`;
}

function sanitizeStatus(text: string): string {
    return text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx: ExtensionContext) => {
        if (ctx.mode !== 'tui') {
            return;
        }
        ctx.ui.setFooter((tui, theme, footerData) => {
            const unsub = footerData.onBranchChange(() => tui.requestRender());
            return {
                dispose: unsub,
                invalidate() {},
                render(width: number): string[] {
                    let totalInput = 0;
                    let totalOutput = 0;
                    let totalCacheRead = 0;
                    let totalCacheWrite = 0;
                    let totalCost = 0;
                    let latestCacheHitRate: number | undefined;
                    for (const entry of ctx.sessionManager.getEntries()) {
                        if (entry.type === 'message' && entry.message.role === 'assistant') {
                            const usage = (entry.message as AssistantMessage).usage;
                            totalInput += usage.input;
                            totalOutput += usage.output;
                            totalCacheRead += usage.cacheRead;
                            totalCacheWrite += usage.cacheWrite;
                            totalCost += usage.cost.total;
                            const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
                            latestCacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
                        }
                    }

                    const model = ctx.model;
                    const contextUsage = ctx.getContextUsage();
                    const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
                    const percentValue = contextUsage?.percent ?? 0;
                    const percent = contextUsage?.percent !== null ? percentValue.toFixed(1) : '?';

                    let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
                    const branch = footerData.getGitBranch();
                    if (branch) pwd = `${pwd} (${branch})`;
                    const sessionName = ctx.sessionManager.getSessionName();
                    if (sessionName) pwd = `${pwd} • ${sessionName}`;

                    const statsParts: string[] = [];
                    if (totalInput) statsParts.push(`${ARROW_IN}${formatTokens(totalInput)}`);
                    if (totalOutput) statsParts.push(`${ARROW_OUT}${formatTokens(totalOutput)}`);
                    if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
                    if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
                    if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
                        statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
                    }

                    const usingSub = model ? ctx.modelRegistry.isUsingOAuth(model as Model<never>) : false;
                    if (totalCost || usingSub) {
                        statsParts.push(`$${totalCost.toFixed(3)}${usingSub ? ' (sub)' : ''}`);
                    }

                    const autoIndicator = SHOW_AUTO ? ' (auto)' : '';
                    const contextDisplay =
                        percent === '?'
                            ? `?/${formatTokens(contextWindow)}${autoIndicator}`
                            : `${percent}%/${formatTokens(contextWindow)}${autoIndicator}`;
                    if (percentValue > 90) statsParts.push(theme.fg('error', contextDisplay));
                    else if (percentValue > 70) statsParts.push(theme.fg('warning', contextDisplay));
                    else statsParts.push(contextDisplay);

                    let statsLeft = statsParts.join(' ');
                    let statsLeftWidth = visibleWidth(statsLeft);
                    if (statsLeftWidth > width) {
                        statsLeft = truncateToWidth(statsLeft, width, '...');
                        statsLeftWidth = visibleWidth(statsLeft);
                    }

                    const modelName = model?.id || 'no-model';
                    let rightBase = modelName;
                    if (model?.reasoning) {
                        const level = pi.getThinkingLevel() || 'off';
                        rightBase = level === 'off' ? `${modelName} • thinking off` : `${modelName} • ${level}`;
                    }
                    let rightSide = rightBase;
                    const minPadding = 2;
                    if (footerData.getAvailableProviderCount() > 1 && model) {
                        rightSide = `(${model.provider}) ${rightBase}`;
                        if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) rightSide = rightBase;
                    }

                    const rightWidth = visibleWidth(rightSide);
                    let statsLine: string;
                    if (statsLeftWidth + minPadding + rightWidth <= width) {
                        statsLine = statsLeft + ' '.repeat(width - statsLeftWidth - rightWidth) + rightSide;
                    } else {
                        const availableForRight = width - statsLeftWidth - minPadding;
                        if (availableForRight > 0) {
                            const right = truncateToWidth(rightSide, availableForRight, '');
                            const pad = ' '.repeat(Math.max(0, width - statsLeftWidth - visibleWidth(right)));
                            statsLine = statsLeft + pad + right;
                        } else {
                            statsLine = statsLeft;
                        }
                    }

                    const dimStatsLeft = theme.fg('dim', statsLeft);
                    const dimRemainder = theme.fg('dim', statsLine.slice(statsLeft.length));
                    const pwdLine = truncateToWidth(theme.fg('dim', pwd), width, theme.fg('dim', '...'));
                    const lines = [pwdLine, dimStatsLeft + dimRemainder];

                    const statuses = footerData.getExtensionStatuses();
                    if (statuses.size > 0) {
                        const line = Array.from(statuses.entries())
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([, text]) => sanitizeStatus(text))
                            .join(' ');
                        lines.push(truncateToWidth(line, width, theme.fg('dim', '...')));
                    }
                    return lines;
                },
            };
        });
    });
}
