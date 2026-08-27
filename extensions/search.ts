// /search: keyword search over pi's commands and pi's documentation, plus the
// same search as a tool the agent can call.
//
// pi's `/` completion matches command names only, so a command is findable only
// from a word inside its own name. the descriptions are shown but never
// searched, the docs are not searched at all, and the agent has no access to
// either list. `/search jsonl` returns /export and /import; `/search move a
// session to another machine` returns them too, because the doc prose is in the
// index (see lib/pi-docs.ts for the sources and the scoring).
//
// results render as a CustomEntry, which draws in the transcript but does not
// enter the LLM context, so searching does not cost context. the agent gets its
// own copy through the pi_search tool, which returns text.

import { Type } from '@earendil-works/pi-ai';
import {
    defineTool,
    type EntryRenderOptions,
    type ExtensionAPI,
    type Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { config } from './lib/config';
import {
    buildIndex,
    hitOrigin,
    hitTitle,
    search,
    type Hit,
    type IndexReport,
    type SearchOptions,
    type SessionCommand,
} from './lib/pi-docs';

const ENTRY_TYPE = 'rho-search-results';

interface ResultLine {
    readonly title: string;
    readonly origin: string;
    readonly snippet: string;
    readonly isCommand: boolean;
}

interface Results {
    readonly query: string;
    readonly lines: readonly ResultLine[];
    readonly total: number;
    readonly warning: string | null;
}

function toLine(hit: Hit): ResultLine {
    return {
        title: hitTitle(hit),
        origin: hitOrigin(hit),
        snippet: hit.snippet,
        isCommand: hit.record.kind === 'command',
    };
}

function renderResults(data: Results, theme: Theme, width: number): string[] {
    const dim = (s: string): string => theme.fg('dim', s);
    const out: string[] = [dim(`search: ${data.query}`), ''];
    if (data.warning !== null) out.push(theme.fg('warning', data.warning), '');
    if (data.lines.length === 0) {
        out.push(dim('no matches'));
    }
    for (const line of data.lines) {
        const head = theme.bold(theme.fg(line.isCommand ? 'accent' : 'mdLink', line.title));
        out.push(`${head}  ${dim(line.origin)}`);
        if (line.snippet !== '') out.push(`  ${line.snippet}`);
    }
    if (data.total > data.lines.length) {
        out.push('', dim(`${data.total - data.lines.length} more`));
    }
    return out.map((line) => truncateToWidth(line, width, dim('…')));
}

/**
 * the index is built once per session and reused. `/reload` re-runs the
 * extension factory, which is what picks up a pi upgrade or a new extension
 * command.
 */
function indexer(pi: ExtensionAPI): () => IndexReport {
    let cached: IndexReport | null = null;
    return () => {
        if (cached === null) {
            const sessionCommands = pi.getCommands() as unknown as readonly SessionCommand[];
            cached = buildIndex({
                sessionCommands,
                extraDocRoots: config.search.docRoots,
            });
        }
        return cached;
    };
}

function warningFor(report: IndexReport): string | null {
    if (report.piRoot === null) return "pi's install was not found: built-in commands and docs are not indexed";
    if (report.builtinsFound === 0) return 'built-in commands were not found in this pi build; only docs and session commands are indexed';
    return null;
}

export default function (pi: ExtensionAPI) {
    const getIndex = indexer(pi);

    pi.registerEntryRenderer<Results>(ENTRY_TYPE, (entry, _options: EntryRenderOptions, theme): Component | undefined => {
        const data = entry.data;
        if (!data) return undefined;
        return {
            invalidate() {},
            render(width: number): string[] {
                return renderResults(data, theme, width);
            },
        };
    });

    pi.registerCommand('search', {
        description: 'Search pi commands and documentation by keyword',
        handler: async (args, ctx) => {
            const query = args.trim();
            if (query === '') {
                ctx.ui.notify('usage: /search <words>', 'info');
                return;
            }
            const report = getIndex();
            const limit = config.search.maxResults;
            const hits = search(report.records, query, { limit });
            const all = search(report.records, query, { limit: limit * 4 });
            pi.appendEntry<Results>(ENTRY_TYPE, {
                query,
                lines: hits.map(toLine),
                total: all.length,
                warning: warningFor(report),
            });
        },
    });

    if (!config.search.tool) return;

    pi.registerTool(
        defineTool({
            name: 'pi_search',
            label: 'Search pi',
            description:
                "Search pi's own slash commands and pi's documentation by keyword. " +
                'Use when asked what command does something, how to do something in pi, ' +
                'or about a pi flag, setting, or session behaviour. ' +
                'Matches command names, command descriptions, and the markdown docs shipped with pi.',
            parameters: Type.Object({
                query: Type.String({ description: 'Words to search for, e.g. "export session jsonl".' }),
                kind: Type.Optional(
                    Type.Union([Type.Literal('command'), Type.Literal('doc'), Type.Literal('all')], {
                        description: 'Restrict results to commands or documentation. Default: all.',
                    }),
                ),
                limit: Type.Optional(Type.Number({ description: 'Maximum results. Default 12.' })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
                const report = getIndex();
                const options: SearchOptions = {
                    limit: params.limit ?? config.search.maxResults,
                    kind: params.kind ?? 'all',
                };
                const hits = search(report.records, params.query, options);
                const warning = warningFor(report);
                const body =
                    hits.length === 0
                        ? 'no matches'
                        : hits
                              .map((hit) => {
                                  const head = `${hitTitle(hit)}  [${hitOrigin(hit)}]`;
                                  return hit.snippet === '' ? head : `${head}\n    ${hit.snippet}`;
                              })
                              .join('\n');
                const text = warning === null ? body : `${warning}\n\n${body}`;
                return { content: [{ type: 'text', text }], details: {} };
            },
        }),
    );
}
