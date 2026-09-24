// /personality [name | path | off]: set how the agent speaks for this session.
//
// two ways in, chosen by what the session already holds:
//
//   prompt   nothing has been said yet, so the personality is appended to the
//            system prompt on every turn, ahead of the first request.
//   message  the conversation has started, so the personality goes in as one
//            custom message and the system prompt is left byte for byte as it
//            was.
//
// the split is about the provider's prompt cache. the system prompt is the
// cached prefix of every request in the session; editing it mid-session
// invalidates that prefix and the whole conversation is re-read on the next
// turn. a message appended after the last cached turn costs the tokens of the
// personality and nothing else.
//
// the one case that cannot be had cheaply: switching or clearing a personality
// that is already in the system prompt. the old block has to go, and removing
// it is the same cache cost as replacing it, so the block is rewritten and the
// cost is reported rather than hidden by leaving a contradicted instruction in
// the prompt.
//
// with no argument, `PERSONALITY.md` at the root of the working tree is what a
// project asks for, and `[personality] auto` reads it at session start so it
// arrives in the prompt rather than in the conversation. the file name is
// `[personality] project-file`; the session's choice is stored per session, so
// a resume keeps it, under `[personality] remember`.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { config } from './lib/core/config';
import { PersistedState } from './lib/core/state-store';
import { collapseHome } from './lib/core/text';
import {
    announcement,
    block,
    catalogue,
    expandPath,
    type InjectionMode,
    type Personality,
    type PersonalityOrigin,
    projectPersonality,
    read,
    resolveArgument,
    revocation,
} from './lib/prose/personality';

const STATE_VERSION = 1;
const OFF = 'off';
// a personality for a session nobody types into: `RHO_PERSONALITY=noir pi`, and
// `bun tools/prompt-full.ts --personality noir`, which is the only way to see
// the block in the payload a headless run sends.
const ENV_VAR = 'RHO_PERSONALITY';

interface Active {
    readonly personality: Personality;
    readonly mode: InjectionMode;
}

interface PersonalityState {
    readonly version: typeof STATE_VERSION;
    readonly name: string;
    readonly origin: PersonalityOrigin;
    readonly path: string;
    readonly text: string;
    readonly mode: InjectionMode;
}

const ORIGINS: readonly PersonalityOrigin[] = ['bundled', 'user', 'project', 'file'];
const MODES: readonly InjectionMode[] = ['prompt', 'message'];

function parseState(raw: unknown): PersonalityState | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (s.version !== STATE_VERSION) return null;
    const { name, origin, path, text, mode } = s;
    if (typeof name !== 'string' || typeof path !== 'string' || typeof text !== 'string' || text === '') return null;
    if (!ORIGINS.includes(origin as PersonalityOrigin)) return null;
    if (!MODES.includes(mode as InjectionMode)) return null;
    return {
        version: STATE_VERSION,
        name,
        origin: origin as PersonalityOrigin,
        path,
        text,
        mode: mode as InjectionMode,
    };
}

function toState(active: Active): PersonalityState {
    return {
        version: STATE_VERSION,
        name: active.personality.name,
        origin: active.personality.origin,
        path: active.personality.path,
        text: active.personality.text,
        mode: active.mode,
    };
}

// a personality set before anything is said can live in the system prompt;
// once a user or assistant message exists, the prefix is cached and stays put.
function hasHistory(entries: readonly SessionEntry[]): boolean {
    return entries.some(
        (entry) => entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant'),
    );
}

function describe(active: Active): string {
    const where = active.personality.origin === 'file' || active.personality.origin === 'project'
        ? collapseHome(active.personality.path)
        : active.personality.origin;
    return `${active.personality.name} (${where}, ${active.mode})`;
}

export default function (pi: ExtensionAPI) {
    let active: Active | null = null;
    let store: PersistedState<PersonalityState> | null = null;

    const remember = () => {
        if (store === null) return;
        if (active === null) store.clear();
        else store.write(toState(active));
    };

    /**
     * apply a personality, choosing the mode from the session's state. an
     * existing prompt-mode block keeps prompt mode, because it has to be
     * rewritten either way.
     */
    const apply = (personality: Personality, ctx: ExtensionContext): Active => {
        const cached = hasHistory(ctx.sessionManager.getEntries());
        const mode: InjectionMode = !cached || active?.mode === 'prompt' ? 'prompt' : 'message';
        active = { personality, mode };
        remember();
        if (mode === 'message') {
            pi.sendMessage(
                { customType: 'personality', content: announcement(personality), display: true },
                { deliverAs: 'nextTurn' },
            );
        }
        return active;
    };

    const clear = (ctx: ExtensionContext): Active | null => {
        const previous = active;
        if (previous === null) return null;
        active = null;
        remember();
        if (previous.mode === 'message' && hasHistory(ctx.sessionManager.getEntries())) {
            pi.sendMessage(
                { customType: 'personality', content: revocation(previous.personality.name), display: true },
                { deliverAs: 'nextTurn' },
            );
        }
        return previous;
    };

    pi.on('session_start', async (_event, ctx) => {
        active = null;
        store = config.personality.remember
            ? PersistedState.open(
                { name: 'personality', scope: 'session', parse: parseState },
                { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
            )
            : null;

        const stored = store?.read() ?? null;
        if (stored !== null) {
            // the stored text is what was sent, so it is used as it stands: a
            // file edited or deleted since does not change what this session
            // has already been told.
            active = {
                personality: { name: stored.name, origin: stored.origin, path: stored.path, text: stored.text },
                mode: stored.mode,
            };
            return;
        }

        const named = process.env[ENV_VAR]?.trim() ?? '';
        if (named !== '' && named !== OFF) {
            const result = resolveArgument(named, ctx.cwd);
            if (result.kind === 'ok') {
                active = { personality: result.personality, mode: 'prompt' };
                remember();
                return;
            }
            ctx.ui.notify(`${ENV_VAR}: no personality named ${named}`, 'error');
            return;
        }

        if (!config.personality.auto || config.personality.projectFile === '') return;
        const project = projectPersonality(ctx.cwd, config.personality.projectFile);
        if (project === null) return;
        // prompt mode regardless of history: session_start is before this
        // process has sent anything, and a resumed session pays one prefix
        // rebuild rather than carrying a personality the prompt does not state.
        active = { personality: project, mode: 'prompt' };
        remember();
        ctx.ui.notify(`personality: ${describe(active)}`, 'info');
    });

    pi.on('before_agent_start', async (event) => {
        if (active === null || active.mode !== 'prompt') return;
        return { systemPrompt: `${event.systemPrompt}\n\n${block(active.personality)}` };
    });

    pi.registerCommand('personality', {
        description: 'set the personality for this session (name, path, or off)',
        getArgumentCompletions: (prefix) => {
            const raw = prefix.trim();
            if (raw.includes('/')) {
                const cut = raw.lastIndexOf('/');
                const dirPart = raw.slice(0, cut + 1);
                const partial = raw.slice(cut + 1).toLowerCase();
                const baseAbs = expandPath(dirPart, process.cwd());
                try {
                    if (!statSync(baseAbs).isDirectory()) return null;
                    const items = readdirSync(baseAbs, { withFileTypes: true })
                        .filter((e) => (e.isDirectory() || e.name.endsWith('.md'))
                            && e.name.toLowerCase().startsWith(partial))
                        .map((e): AutocompleteItem => ({
                            value: dirPart + e.name + (e.isDirectory() ? '/' : ''),
                            label: dirPart + e.name,
                        }));
                    return items.length > 0 ? items : null;
                } catch {
                    return null;
                }
            }
            const items: AutocompleteItem[] = catalogue()
                .filter((ref) => ref.name.toLowerCase().startsWith(raw.toLowerCase()))
                .map((ref) => ({ value: ref.name, label: ref.name, description: `(${ref.origin})` }));
            if (OFF.startsWith(raw.toLowerCase())) {
                items.push({ value: OFF, label: OFF, description: '(clear)' });
            }
            return items.length > 0 ? items : null;
        },
        handler: async (args, ctx) => {
            const arg = args.trim();

            if (arg === '') {
                const names = catalogue().map((ref) => ref.name);
                const projectFile = config.personality.projectFile;
                const hasProject = projectFile !== '' && existsSync(join(ctx.cwd, projectFile));
                const options = [
                    ...(hasProject ? [projectFile] : []),
                    ...names,
                    ...(active === null ? [] : [OFF]),
                ];
                if (options.length === 0) {
                    ctx.ui.notify(`no personalities found; write one to ${collapseHome(join(ctx.cwd, 'PERSONALITY.md'))}`, 'warning');
                    return;
                }
                const title = active === null ? 'personality: none' : `personality: ${describe(active)}`;
                const choice = await ctx.ui.select(title, options);
                if (choice === null || choice === undefined) return;
                if (choice === OFF) {
                    const previous = clear(ctx);
                    ctx.ui.notify(previous === null ? 'personality: none' : `personality: none (was ${previous.personality.name})`, 'info');
                    return;
                }
                const picked = choice === projectFile
                    ? read(join(ctx.cwd, projectFile), 'project')
                    : resolveArgument(choice, ctx.cwd);
                if (picked.kind !== 'ok') {
                    ctx.ui.notify(`personality: could not read ${choice}`, 'error');
                    return;
                }
                ctx.ui.notify(`personality: ${describe(apply(picked.personality, ctx))}`, 'info');
                return;
            }

            if (arg === OFF || arg === 'none') {
                const previous = clear(ctx);
                if (previous === null) {
                    ctx.ui.notify('personality: none', 'info');
                    return;
                }
                const note = previous.mode === 'prompt' ? ', system prompt rebuilt' : '';
                ctx.ui.notify(`personality: none (was ${previous.personality.name}${note})`, 'info');
                return;
            }

            const result = resolveArgument(arg, ctx.cwd);
            switch (result.kind) {
                case 'unknown':
                    ctx.ui.notify(
                        result.known.length === 0
                            ? `no personality named ${result.name}, and none are installed`
                            : `no personality named ${result.name}; known: ${result.known.join(', ')}`,
                        'error',
                    );
                    return;
                case 'missing':
                    ctx.ui.notify(`no such file: ${collapseHome(result.path)}`, 'error');
                    return;
                case 'unreadable':
                    ctx.ui.notify(`cannot read ${collapseHome(result.path)}: ${result.message}`, 'error');
                    return;
                case 'ok': {
                    const wasPrompt = active?.mode === 'prompt';
                    const applied = apply(result.personality, ctx);
                    const note = wasPrompt && applied.mode === 'prompt' && hasHistory(ctx.sessionManager.getEntries())
                        ? ', system prompt rebuilt'
                        : '';
                    ctx.ui.notify(`personality: ${describe(applied)}${note}`, 'info');
                    return;
                }
            }
        },
    });
}
