// custom footer: a faithful copy of pi's built-in footer, with the token
// arrows swapped for different glyphs. pi does not expose the arrow chars on
// their own, so the whole footer has to be replaced to change them.
//
// edit ARROW_IN / ARROW_OUT below. everything else mirrors the built-in.

import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { abbreviate, capitalise, collapseHome, oneLine, words } from './lib/text';
import { publishFooter } from './lib/footer-mirror';
import { currentEnvironment } from './environment';

const ARROW_IN = '▲  ';
const ARROW_OUT = '▽  ';

// pi defaults auto-compaction on; flip if you disable it in settings.
const SHOW_AUTO = true;

const formatTokens = (count: number): string => abbreviate(count, 'compact');
const formatCwd = collapseHome;
const sanitizeStatus = oneLine;

// turn a raw model id like `claude-opus-4-8` into a friendly display name like
// `Opus 4.8`. drops vendor prefixes, folds trailing numeric segments into a
// dotted version, title-cases the name words, and uppercases known acronyms.
const VENDOR_PREFIXES = new Set(['claude', 'anthropic', 'openai', 'google', 'meta', 'mistral', 'xai']);
const ACRONYMS = new Set(['gpt', 'ai', 'llm']);
const isVersionToken = (t: string): boolean => /^\d+(\.\d+)*$/.test(t);

function prettifyModelName(id: string): string {
    const tokens = words(id);
    while (tokens.length > 1 && VENDOR_PREFIXES.has(tokens[0].toLowerCase())) {
        tokens.shift();
    }
    const versionTokens: string[] = [];
    while (tokens.length > 1 && isVersionToken(tokens[tokens.length - 1])) {
        versionTokens.unshift(tokens.pop() as string);
    }
    const name = tokens
        .map((t) => {
            const low = t.toLowerCase();
            return ACRONYMS.has(low) ? low.toUpperCase() : capitalise(low);
        })
        .join(' ');
    const version = versionTokens.join('.');
    return version ? `${name} ${version}` : name;
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx: ExtensionContext) => {
        if (ctx.mode !== 'tui') {
            return;
        }
        ctx.ui.setFooter((tui, theme, footerData) => {
            // flip clearOnShrink live so the current session drops leftover blank
            // rows on shrink; clear-on-shrink.ts persists it so re-applies keep it.
            tui.setClearOnShrink(true);
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

                    // where the work happens, when it is not this machine.
                    //
                    // the directory on the footer is the laptop's, and while an
                    // environment is attached that is not where anything runs:
                    // the machine is stated first, in bold, because reading the
                    // path as local is how a command goes to the wrong host.
                    const elsewhere = currentEnvironment();
                    const remote = elsewhere !== undefined && elsewhere.alive ? elsewhere : null;

                    let pwd = remote === null
                        ? formatCwd(process.cwd(), process.env.HOME || process.env.USERPROFILE)
                        : remote.cwd;
                    const branch = footerData.getGitBranch();
                    if (branch && remote === null) pwd = `${pwd} (${branch})`;
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

                    // fold extension statuses (e.g. token-rate-pi's TPS) into the
                    // stats line next to $-spend and context, instead of a
                    // separate third line.
                    for (const [, text] of Array.from(footerData.getExtensionStatuses().entries()).sort(
                        ([a], [b]) => a.localeCompare(b),
                    )) {
                        const clean = sanitizeStatus(text);
                        if (clean) statsParts.push(clean);
                    }

                    let statsLeft = statsParts.join(' ');
                    let statsLeftWidth = visibleWidth(statsLeft);
                    if (statsLeftWidth > width) {
                        statsLeft = truncateToWidth(statsLeft, width, '...');
                        statsLeftWidth = visibleWidth(statsLeft);
                    }

                    const modelName = model?.id ? prettifyModelName(model.id) : 'no-model';
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
                    const marker = remote === null ? '' : theme.bold(theme.fg('accent', `${remote.host} `));
                    const pwdLine = truncateToWidth(
                        marker + theme.fg('dim', pwd),
                        width,
                        theme.fg('dim', '...'),
                    );
                    const lines = [pwdLine, dimStatsLeft + dimRemainder];
                    // the theme picker shows a session, and this is that
                    // session's footer; it cannot build one of its own.
                    publishFooter(lines);
                    return lines;
                },
            };
        });
    });
}
