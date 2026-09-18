// rho config loader.
//
// the file lives wherever env-paths puts it: ~/Library/Preferences/rho/rho.toml
// on macOS, $XDG_CONFIG_HOME/rho/rho.toml (or ~/.config/rho/rho.toml) on linux.
// a missing file is not an error; every key falls back to its default.
//
// SCHEMA below is the single declaration of the config. each field carries its
// TOML key, its default, and its documentation, and everything else is derived
// from it: the RhoConfig type, the defaults, TOML -> config, config -> TOML,
// and the comments in the emitted file. adding a key means adding one line.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import envPaths from 'env-paths';
import { parse, stringify } from 'smol-toml';

const paths = envPaths('rho', { suffix: '' });
const CONFIG_PATH = join(paths.config, 'rho.toml');

/**
 * a runtime check paired with the type it narrows to. `label` names the
 * expectation for error messages.
 *
 * this is what a field is checked against, rather than the shape of its
 * default. a default can only ever imply its own shape, which leaves two
 * holes: an empty array default carries no element to compare against, and no
 * default can express a constraint narrower than its type, such as requiring a
 * positive integer.
 */
interface Guard<T> {
    (value: unknown): value is T;
    label: string;
}

function guard<T>(label: string, test: (value: unknown) => boolean): Guard<T> {
    const g = ((value: unknown) => test(value)) as unknown as Guard<T>;
    g.label = label;
    return g;
}

export const isBool = guard<boolean>('boolean', (v) => typeof v === 'boolean');
export const isString = guard<string>('string', (v) => typeof v === 'string');
export const isPosInt = guard<number>(
    'positive integer',
    (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
);
export const isStringArray = guard<string[]>(
    'array of string',
    (v) => Array.isArray(v) && v.every((element) => typeof element === 'string'),
);
// one line or a pool to draw from, so a setting that names a message does not
// force a single-element array on anyone who only wants one.
export const isStringOrStringArray = guard<string | string[]>(
    'string or array of string',
    (v) => typeof v === 'string' || (Array.isArray(v) && v.every((element) => typeof element === 'string')),
);
// a table of overrides: every value a string, every key a name the reader
// chooses, so the schema cannot enumerate them.
export const isStringRecord = guard<Record<string, string>>(
    'table of string',
    (v) =>
        typeof v === 'object' && v !== null && !Array.isArray(v)
        && Object.values(v as Record<string, unknown>).every((e) => typeof e === 'string'),
);
export const isNumberArray = guard<number[]>(
    'array of number',
    (v) => Array.isArray(v) && v.every((element) => typeof element === 'number'),
);
export const isUnitFloat = guard<number>(
    'number in [0, 1]',
    (v) => typeof v === 'number' && v >= 0 && v <= 1,
);

export interface GradientStops {
    colors: string[];
    stops: number[];
}

export type GradientSpec = string[] | GradientStops;

export const isGradientSpec = guard<GradientSpec>(
    'colour array or { colors = [...], stops = [...] }',
    (v) => {
        if (Array.isArray(v)) return v.every((e) => typeof e === 'string');
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            const o = v as Record<string, unknown>;
            return Array.isArray(o.colors)
                && o.colors.every((e: unknown) => typeof e === 'string')
                && Array.isArray(o.stops)
                && o.stops.every((e: unknown) => typeof e === 'number' && e >= 0 && e <= 1)
                && o.colors.length === o.stops.length;
        }
        return false;
    },
);

/**
 * a closed set of strings. the guard narrows to the union of the members, so a
 * field built with it has a literal union type rather than `string`, and the
 * default is checked against the members at compile time.
 */
export function isOneOf<const T extends readonly [string, ...string[]]>(...allowed: T): Guard<T[number]> {
    return guard<T[number]>(
        allowed.map((member) => `"${member}"`).join(' | '),
        (v) => typeof v === 'string' && (allowed as readonly string[]).includes(v),
    );
}

interface Field<T> {
    /** key as it appears in the TOML file (kebab-case) */
    key: string;
    /** what the file must supply; also the runtime check */
    check: Guard<T>;
    default: T;
    /** lines emitted as `#` comments above the key */
    doc: string[];
}

/**
 * T comes from the guard's predicate, so no field needs an explicit type
 * argument, and `def` is checked against it: a default that contradicts its
 * guard is a compile error.
 */
function field<T>(key: string, check: Guard<T>, def: T, ...doc: string[]): Field<T> {
    return { key, check, default: def, doc };
}

// the schema constraint drops the predicate's type parameter rather than
// widening it. Field<unknown> would not work, because a Guard<T> is a predicate
// on its parameter and Guard<boolean> is therefore not assignable to
// Guard<unknown>; but a type predicate IS assignable to a plain
// boolean-returning function, and any default is assignable to unknown. so this
// admits every Field<T> without an `any`.
interface AnyGuard {
    (value: unknown): boolean;
    label: string;
}

interface AnyField {
    key: string;
    check: AnyGuard;
    default: unknown;
    doc: string[];
}

type Section = Record<string, AnyField>;
type Schema = Record<string, Section>;

/**
 * the TOML face of a schema identifier. a section is named by its javascript
 * property, which has to be an identifier, so `sendNow` reached the file as
 * `[sendNow]` while every key beside it was kebab-case. deriving the name means
 * the file spells one convention throughout and no section can drift from its
 * property.
 */
export function tomlName(identifier: string): string {
    return identifier.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** one property per field, typed by that field's default. */
type ConfigOf<S extends Schema> = {
    -readonly [Sec in keyof S]: {
        -readonly [K in keyof S[Sec]]: S[Sec][K] extends Field<infer T> ? T : never;
    };
};

const SCHEMA = {
    spinner: {
        categories: field(
            'categories',
            isStringArray,
            ['chinese'],
            'which spinner sets to use (defined in extensions/assets/spinners.json)',
        ),
        done: field(
            'done',
            isString,
            '完',
            'glyph shown on the completion line when the agent finishes',
        ),
        shimmerSpeed: field(
            'shimmer-speed',
            isPosInt,
            80,
            'ms per frame for the shimmer color sweep on working messages',
        ),
        placement: field(
            'placement',
            isOneOf('border', 'dock'),
            'dock',
            'where the spinner and its working message are drawn. dock: the row',
            'below the input field, on its own line, with the full width for a long',
            'message. border: cut into the top edge of the field, which is where pi',
            '0.85 moved it',
        ),
    },
    audit: {
        model: field(
            'model',
            isString,
            'anthropic/claude-haiku-4-5',
            'which model /audit sends the last reply to for review, as',
            'provider/id, or "current" for the session model',
        ),
        feedback: field(
            'feedback',
            isOneOf('context', 'transcript', 'both'),
            'both',
            'context always asks before sending, never sends unattended. transcript:',
            'a report renders here and nothing is ever offered to the agent. both:',
            'the report renders here and sending is still offered, on approval',
        ),
        timeoutMs: field(
            'timeout-ms',
            isPosInt,
            30_000,
            'abort the reviewer call after this long; a timeout reports as an error',
        ),
        audience: field(
            'audience',
            isString,
            'an expert in the general field, unfamiliar with this repository and this conversation',
            'what the auditor assumes its reader already knows. the skill requires',
            'this parameter and asks for it when absent',
        ),
    },
    goal: {
        model: field(
            'model',
            isString,
            'anthropic/claude-haiku-4-5',
            'which model judges the condition after each turn, as provider/id, or',
            '"current" for the session model. a small fast model is the intended',
            'choice: the judge reads a transcript and answers one structured question',
        ),
        timeoutMs: field(
            'timeout-ms',
            isPosInt,
            30_000,
            'abort the judge call after this long. a timeout ends the turn and',
            'leaves the goal set, so the next turn evaluates again',
        ),
        transcriptFraction: field(
            'transcript-fraction',
            isUnitFloat,
            0.5,
            "how much of the judge's context window the transcript may fill.",
            'older entries are dropped first, and a truncated transcript tells the',
            'judge to answer "insufficient evidence" rather than guess',
        ),
        blockCap: field(
            'block-cap',
            isPosInt,
            8,
            'how many consecutive unmet verdicts may restart the turn before the',
            'loop hands control back. the goal stays set and resumes on your next',
            'message, so a stalled loop costs this many turns rather than the session',
        ),
        maxChars: field(
            'max-chars',
            isPosInt,
            4000,
            'longest condition accepted by /goal',
        ),
        checkingMessages: field(
            'checking-messages',
            isStringOrStringArray,
            [],
            'what the spinner says while the judge reads the transcript. one string',
            'is used every time; an array is drawn from at each check; the empty',
            'array (the default) draws from extensions/assets/maxims.txt, the same',
            'pool the working message uses',
        ),
        persist: field(
            'persist',
            isBool,
            true,
            'restore an active goal when the session resumes. the condition comes',
            'back; the timer, the turn count, and the token baseline restart',
        ),
    },
    wordswap: {
        enabled: field(
            'enabled',
            isBool,
            true,
            'whether the word filter is active (toggle at runtime with /noswap)',
        ),
        rememberToggle: field(
            'remember-toggle',
            isBool,
            true,
            'store what /noswap last set for this session, so a resume comes back',
            'with the filter as it was left rather than back at `enabled`',
        ),
    },
    startup: {
        animate: field('animate', isBool, true, 'play the logo animation on launch'),
        durationMs: field('duration-ms', isPosInt, 2500, 'total animation duration in ms'),
        modes: field('modes', isStringArray, ['fade', 'build', 'scatter', 'pi', 'rho', 'tetris'], 'intro modes'),
        weights: field('weights', isNumberArray, [0.20, 0.10, 0.10, 0.15, 0.15, 0.30], 'mode weights'),
        shimmerDirs: field('shimmer-dirs', isStringArray, ['ns', 'ew', 'nwse', 'nesw'], 'shimmer axes'),
    },
    images: {
        width: field('width', isPosInt, 60, 'width in terminal cells for inline images'),
        maxHeightFraction: field(
            'max-height-fraction',
            isUnitFloat,
            0.4,
            'largest share of the terminal height an inline image may occupy.',
            'pi caps image width only, so a tall image can be drawn taller than',
            'the window and text then lands on top of it. 1 removes the cap.',
        ),
    },
    quit: {
        words: field(
            'words',
            isStringArray,
            ['quit', 'exit'],
            'words that end the session, matched without regard to case. each one',
            'works as a command (/exit) and, when bare-word is on, as a message',
            'holding nothing else. a word pi already defines as a command (quit)',
            'stays pi\'s, since pi matches its own commands first',
        ),
        bareWord: field(
            'bare-word',
            isBool,
            true,
            'whether one of the words alone, with no slash, exits. off leaves the',
            'slash forms only, so typing quit sends the word to the model',
        ),
    },
    cwd: {
        remember: field(
            'remember',
            isBool,
            true,
            'store where /cwd last pointed for this session and return there on a',
            'resume, when the directory still exists',
        ),
    },
    personality: {
        projectFile: field(
            'project-file',
            isString,
            'PERSONALITY.md',
            'the file /personality reads from the working tree when no argument is',
            'given and no personality is set. an empty string disables the lookup',
        ),
        auto: field(
            'auto',
            isBool,
            true,
            'load the project file at session start, before the first turn, so it',
            'lands in the system prompt rather than in the conversation',
        ),
        remember: field(
            'remember',
            isBool,
            true,
            'store the personality for this session and restore it on a resume, in',
            'the mode it was applied in',
        ),
    },
    http: {
        keepAliveMs: field(
            'keep-alive-ms',
            isPosInt,
            15_000,
            'how long an unused connection may be kept before it is closed rather',
            'than reused. a machine behind NAT loses the record of an idle flow',
            'after a few minutes and then answers nothing, so a connection older',
            'than that window is a request that hangs until it times out. 0 keeps',
            "whatever pi installed",
        ),
        responseMs: field(
            'response-ms',
            isPosInt,
            120_000,
            'how long to wait for a response that has begun but stopped arriving',
        ),
    },

    remote: {
        commandsHere: field(
            'commands-here',
            isStringArray,
            [
                'attach',
                'context',
                'detach',
                'environment',
                'exit',
                'history',
                'prompt',
                'quit',
                'remote',
                'restart',
                'rho',
                'search',
                'stash',
                'syntax',
                'theme',
                'theme-picker',
                'web',
            ],
            'while attached to a session on another machine, the commands that run',
            'in this interface rather than in the session. everything else goes to',
            'the far side, which is where the files, the checkpoints and the',
            'conversation are; a command only this machine has runs here whether it',
            'is listed or not. /cwd is deliberately absent: the directory that',
            'matters is the one the agent works in, and moving this machine into a',
            'directory the session cannot see is how a move is reported that never',
            'happened',
        ),
        carryContext: field(
            'carry-context',
            isBool,
            true,
            'carry the conversation between this machine and a session on another',
            'one. connecting to a session that has never been used hands it this',
            "conversation, and leaving it brings back what was said there, so the",
            'two are one thread that can be worked on from either side. a session',
            'that already has a conversation of its own is left alone',
        ),
        leaveDefault: field(
            'leave-default',
            isOneOf('carry', 'leave', 'exit'),
            'carry',
            'which way out the cursor starts on when an interface onto a session',
            'on another machine is closed. the session keeps running in all',
            'three. carry: bring what was said there into the local session.',
            'leave: the local session as it was before connecting, and the far',
            'side keeps what was said. exit: the same, and out to the shell',
        ),
        relayUi: field(
            'relay-ui',
            isBool,
            true,
            "draw the far side's notifications, status lines, widgets and dialogs in",
            'this interface, and send the answers back. a session running as a',
            'daemon has no terminal of its own, so without this its extensions',
            'write into nothing and any dialog they open waits for ever',
        ),
    },

    rewind: {
        autoCheckpoint: field(
            'auto-checkpoint',
            isOneOf('git', 'always', 'never'),
            'git',
            'when pi-rewind takes a checkpoint of the working directory each turn.',
            'git: only inside a git work tree, and never in the home directory,',
            'since a snapshot of everything under home runs past the checkpoint',
            "engine's own two-minute timeout. always: everywhere. never: nowhere",
        ),
        onFailure: field(
            'on-failure',
            isOneOf('disable-session', 'keep-trying'),
            'disable-session',
            'what happens when a checkpoint cannot be taken. disable-session:',
            'say why in one line at the top of the session and show nothing',
            'after that, since the cause (not a git repo, an unreadable path, a',
            'work tree too large to stage inside the two-minute timeout) does',
            'not change while the session runs. keep-trying: pi-rewind\'s own',
            'behaviour, one attempt and one warning per turn',
        ),
    },
    stash: {
        persist: field(
            'persist',
            isOneOf('project', 'session', 'global', 'off'),
            'project',
            'where parked prompts are kept between runs. project: one stack per',
            'working directory, restored on every start there. session: one stack',
            'per session, restored on resume. global: one stack everywhere. off:',
            'in memory only, so the stack dies with the process',
        ),
        demoteTo: field(
            'demote-to',
            isStringArray,
            ['f2', 'f3', 'f4', 'f5', 'f6'],
            'spare keys for the built-in actions that share ctrl+s / ctrl+r with the',
            'stash. pi reports every such shared key at startup, even under',
            'quietStartup, so each colliding action is moved to the next unused key',
            'in this list. an empty list leaves pi alone and keeps the report',
        ),
    },
    history: {
        persist: field(
            'persist',
            isOneOf('project', 'session', 'global', 'off'),
            'project',
            'where prompt history is stored. project: one log per working directory,',
            'so prompts from any session in that dir are reachable. session: one log',
            'per session, restored on resume. global: one log everywhere. off:',
            'in memory only, pi\'s own 100-entry cap applies',
        ),
        maxEntries: field(
            'max-entries',
            isPosInt,
            500,
            'how many prompts to keep in the log. includes both sent and unsent',
        ),
        saveDrafts: field(
            'save-drafts',
            isBool,
            true,
            'capture unsent drafts when navigating away (arrow-up) or exiting',
        ),
        debounceMs: field(
            'debounce-ms',
            isPosInt,
            750,
            'how often to snapshot the in-progress draft while typing. a crash loses',
            'at most this much typing',
        ),
        searchKey: field(
            'search-key',
            isString,
            'ctrl+f',
            'the key that opens the incremental search over the log. ctrl+r, which',
            'a shell uses for this, parks and restores prompts here (see [stash]),',
            'so search takes the find key instead. ctrl+f is pi\'s second binding',
            'for moving the cursor right, which the right arrow also does, so the',
            'built-in loses that key and keeps the arrow. empty binds nothing',
        ),
        seedQueryChars: field(
            'seed-query-chars',
            isPosInt,
            40,
            'search opens carrying the editor text as its query when the text is one',
            'line no longer than this. longer or multi-line text opens an empty',
            'query instead of one that matches nothing',
        ),
    },
    input: {
        halfBlockEdges: field(
            'half-block-edges',
            isBool,
            true,
            'replace the thin ─ border lines with half-block characters (▄ top, ▀',
            'bottom) coloured to match the field background',
        ),
        background: field(
            'background',
            isBool,
            true,
            'fill the input field content rows with a gradient background derived',
            'from the user message bubble colour, matching the edge gradient',
        ),
        gradient: field(
            'gradient',
            isOneOf('off', 'edges'),
            'edges',
            'horizontal colour gradient on the input field. off: flat accent.',
            'edges: gradient on the half-block border rows and content background',
        ),
        darken: field(
            'darken',
            isUnitFloat,
            0.25,
            'how far to shift the user bubble colour for the field background.',
            '0 = same as bubble, 1 = fully dark or light (auto-detected)',
        ),
        tint: field(
            'tint',
            isUnitFloat,
            0.3,
            'how much each gradient colour shows through over the field',
            'background. 0 = invisible, 1 = full saturation. applied after',
            'any per-stop @filters',
        ),
        gradientColors: field(
            'gradient-colors',
            isGradientSpec,
            ['border', 'userMessageBg'],
            'gradient colour stops for the default mode, left to right. each',
            'entry is a theme colour name (e.g. "border") or a hex code.',
            'for custom stop positions:',
            '  { colors = ["border", "userMessageBg"], stops = [0.0, 0.35] }',
        ),
        bashColors: field(
            'bash-colors',
            isGradientSpec,
            ['bashMode', 'userMessageBg'],
            'gradient colour stops for bash mode',
        ),
    },
    hint: {
        enabled: field(
            'enabled',
            isBool,
            true,
            'while a slash command is being typed, show the form it is on its way',
            'to at the right-hand end of the input field, under the text',
        ),
        color: field(
            'color',
            isString,
            'muted',
            'the colour the hint is drawn in, as a theme colour name or a hex',
            'code, with optional HSL filters after an @ (e.g. "muted@s*0.4").',
            'a theme that leaves that role empty (which means the terminal\'s',
            'own colour, and so has no value to fade towards) falls through to',
            'the first of muted, dim, border, accent, text that it does set',
        ),
        gap: field(
            'gap',
            isPosInt,
            2,
            'columns kept clear between the typed text and the first character of',
            'the hint that is drawn at all',
        ),
        fade: field(
            'fade',
            isPosInt,
            12,
            'over how many columns the hint comes up out of the background. a',
            'character this far right of the typed text is drawn at full',
            'strength, one at the text is invisible',
        ),
        strength: field(
            'strength',
            isUnitFloat,
            0.55,
            'how far the hint rises out of the field background at its clearest.',
            '0 = invisible, 1 = the colour above, unblended',
        ),
    },
    sendNow: {
        send: field(
            'send',
            isString,
            'ctrl+enter',
            'stop the running turn and send the editor text now, instead of',
            'queueing it until the turn reaches its next boundary. on an empty',
            'editor it starts the queued steering messages now instead',
        ),
        sendQueued: field(
            'send-queued',
            isString,
            'ctrl+shift+enter',
            'stop the running turn and send the newest queued steering message,',
            'whatever the editor holds. the editor text is neither sent nor cleared',
        ),
        stallWarnMs: field(
            'stall-warn-ms',
            isPosInt,
            6000,
            'how long the aborted turn may take to settle before the pending send is',
            'reported as stalled. the message stays armed either way; pressing the',
            'send key again puts it back in the editor and disarms it',
        ),
        log: field(
            'log',
            isBool,
            false,
            'append a timestamped line per key press, abort, agent event, and send to',
            '<data dir>/rho/send-now.log, for finding where a run that will not stop',
            'is stuck',
        ),
    },
    search: {
        maxResults: field(
            'max-results',
            isPosInt,
            12,
            'how many matches /search shows, and the default for the pi_search tool',
        ),
        docRoots: field(
            'doc-roots',
            isStringArray,
            [],
            'extra markdown files or directories to index alongside pi\'s own',
            "README.md and docs/. a directory is walked four levels deep for *.md",
        ),
        tool: field(
            'tool',
            isBool,
            true,
            'register the pi_search tool, so the agent can search commands and docs',
            'too. the /search command is registered either way',
        ),
    },
    runtime: {
        enforceBun: field(
            'enforce-bun',
            isBool,
            true,
            'stop the session when pi is running under node. rho calls Bun APIs, and',
            'under node those calls fail in ways that reach the prompt as false',
            'statements about the work tree',
        ),
        patchLauncher: field(
            'patch-launcher',
            isBool,
            true,
            "rewrite the shebang of pi's launcher from node to bun, so the next launch",
            'is bun. every pi update restores the node shebang, so this runs again',
        ),
        reexec: field(
            'reexec',
            isBool,
            true,
            'when started under node, re-run pi under bun with the same arguments',
            'and exit with the status of that run. off means print a note and stop',
        ),
    },
    slack: {
        reconnect: field(
            'reconnect',
            isBool,
            true,
            'reopen the socket for the app this session last attached to, when the',
            'session is resumed and no other session holds that app',
        ),
        readEmoji: field(
            'read-emoji',
            isString,
            'eyes',
            'emoji added to an incoming message as the read mark, without colons.',
            'empty to add none. needs the reactions:write scope',
        ),
        typing: field(
            'typing',
            isBool,
            true,
            'set the status line under the conversation while the agent works, which',
            'renders as "<app name> is thinking...". only an assistant or agent app',
            'has that surface; for a plain bot the call fails once and is dropped',
        ),
        loadingMessages: field(
            'loading-messages',
            isStringArray,
            [],
            'what the status line rotates through while a turn runs. slack prefixes',
            'each with the app name. up to ten. the empty array (the default)',
            'draws from extensions/assets/maxims.txt, the same pool the spinner',
            'uses, so one place decides what the agent says while it works',
        ),
        ackMessage: field(
            'ack-message',
            isBool,
            false,
            'also forward the first reply of an exchange as a message, the way the',
            'daemon version did. the status line already says the message landed,',
            'so this costs a message in the thread for nothing unless the app has',
            'no assistant surface',
        ),
        catchUp: field(
            'catch-up',
            isPosInt,
            50,
            'how many messages per conversation to pull with conversations.history',
            'when the socket opens. socket mode delivers nothing that arrived while',
            'no socket was open, so this is what recovers them',
        ),
        maxChars: field(
            'max-chars',
            isPosInt,
            3500,
            'longest reply forwarded to slack; anything longer is cut and marked.',
            "slack's own limit is 40000, and a wall of text on a phone is not a reply",
        ),
    },
    env: {
        enabled: field(
            'enabled',
            isBool,
            true,
            'append an <env> block naming the working directory, the platform, the',
            'date, and the model, so none of it costs a tool call',
        ),
        git: field(
            'git',
            isBool,
            true,
            'whether the block says if the working directory is a git work tree',
        ),
        platform: field(
            'platform',
            isBool,
            true,
            'whether the block names the operating system and its release',
        ),
        shell: field(
            'shell',
            isBool,
            true,
            'whether the block names the shell bash commands are handed to. it',
            'follows the machine: with an environment attached it is that',
            "machine's shell, not this one's",
        ),
        date: field(
            'date',
            isBool,
            true,
            "today's date, frozen at session start. without it a model dates things",
            'from its training cutoff',
        ),
        model: field(
            'model',
            isBool,
            true,
            'whether the block names the active model and thinking level',
        ),
    },
    git: {
        snapshot: field(
            'snapshot',
            isBool,
            true,
            'append a <git> block naming the branch, its divergence from upstream, the',
            'dirty files, and the last few commits, read once at session start',
        ),
        commits: field(
            'commits',
            isPosInt,
            5,
            'how many recent commit subjects the block carries',
        ),
        maxFiles: field(
            'max-files',
            isPosInt,
            20,
            'cap on the dirty-file list, so a repo mid-rebase cannot flood the prompt.',
            'what is dropped is reported as a count',
        ),
        timeoutMs: field(
            'timeout-ms',
            isPosInt,
            2_000,
            'give up on git status and git log after this long and append no block',
        ),
    },
    scratch: {
        location: field(
            'location',
            isOneOf('project', 'data-dir', 'off'),
            'project',
            'where the session scratch directory goes. project puts it in',
            '.rho/scratch/<session>/ inside the working tree, where a workspace-confined',
            'tool can still read it; data-dir puts it under the rho data directory;',
            'off registers nothing and leaves /tmp as the only option',
        ),
        keepDays: field(
            'keep-days',
            isPosInt,
            7,
            'remove scratch directories untouched for this many days, when a session opens',
        ),
    },
    prompt: {
        disenshittify: field(
            'disenshittify',
            isBool,
            true,
            'rewrite the system prompt into the house style before the session',
            'starts: em dashes to the mark the sentence needs, characters and',
            'spacing per system/orthography.md, lower case at a sentence start,',
            'and one line per list item punctuated x; y; z. every markdown file',
            'in rho is already a fixed point of this, so it changes only the',
            'text pi and the bundled packages contribute',
        ),
    },
    render: {
        halfBlocks: field(
            'half-blocks',
            isBool,
            true,
            "a Box's blank padding rows become half-height block characters, so a",
            'tool bubble costs no blank rows',
        ),
        tightToolRows: field(
            'tight-tool-rows',
            isBool,
            true,
            'drop the blank lines a tool row wraps itself in',
        ),
        tightAfterToolRows: field(
            'tight-after-tool-rows',
            isBool,
            true,
            "drop an assistant message's leading blank line when a tool row is what",
            'precedes it (the same blank line is kept after a user bubble)',
        ),
        selfRenderedRows: field(
            'self-rendered-rows',
            isBool,
            true,
            "repair the row of a tool that draws its own box, which is pi's edit",
            'tool and nothing else. pi loses renderShell on the way to the',
            'component, so the row is drawn boxed twice, and the text of a failed',
            'or changed result lands outside the box, on an unpainted line after',
            'a blank one',
        ),
        hideIdleStatus: field(
            'hide-idle-status',
            isBool,
            true,
            "skip pi's IdleStatus, which parks two blank rows in the dock while idle.",
            'needs terminal.clearOnShrink, which clear-on-shrink.ts sets',
        ),
    },
    theme: {
        previewOnFocus: field(
            'preview-on-focus',
            isBool,
            true,
            'apply a theme as its name passes under the cursor in the /theme',
            'completion menu, and put the old one back if nothing is chosen',
        ),
        persist: field(
            'persist',
            isBool,
            true,
            "write a chosen theme to pi's settings, so it survives a restart the",
            'way one picked in /settings does. false keeps it for this session',
        ),
    },
    syntax: {
        previewOnFocus: field(
            'preview-on-focus',
            isBool,
            true,
            'apply a syntax palette as its name passes under the cursor in the',
            '/syntax completion menu, and put the old one back if nothing is chosen',
        ),
        persist: field(
            'persist',
            isBool,
            true,
            "keep a chosen palette in rho's own state, so it survives a restart.",
            "pi's settings hold a theme name and have nowhere to record this",
        ),
    },
    files: {
        overwrite: field(
            'overwrite',
            isOneOf('refuse', 'allow'),
            'refuse',
            'what write does to a file that already holds bytes. refuse: the call',
            'is blocked, and the agent is told to edit the file or remove it',
            'first, since pi\'s own write replaces the contents with no check of',
            'any kind. allow: pi\'s behaviour, one call and the old bytes are gone.',
            'a write whose content matches the file is allowed either way, and so',
            'is a write to an empty or absent file',
        ),
        removeTo: field(
            'remove-to',
            isOneOf('trash', 'delete'),
            'trash',
            'where the remove tool puts what it removes. trash: the machine\'s own',
            'trash command (/usr/bin/trash on macOS 15, gio or trash-put on',
            'linux), so the person can put it back without the agent. delete:',
            'unlinked, recoverable only through the undo journal',
        ),
        undo: field(
            'undo',
            isBool,
            true,
            'record every write, edit and remove, so the agent can take one back',
            'with the undo tool. the copy is made on the machine the file is on,',
            'and the record says what the file looked like afterwards, so an undo',
            'refuses when anything has touched the file since',
        ),
        undoEntries: field(
            'undo-entries',
            isPosInt,
            200,
            'how many mutations one session keeps. the oldest are dropped, and',
            'their copies with them',
        ),
        undoMaxBytes: field(
            'undo-max-bytes',
            isPosInt,
            8_000_000,
            'the largest file copied aside before a mutation. a larger one is',
            'recorded without a copy, and an undo of it can only report that',
            'there is nothing to put back',
        ),
    },
    tools: {
        titles: field(
            'titles',
            isBool,
            true,
            'name a tool row by its derived display name rather than the name the',
            'model calls: slack_reply reads "slack reply", ctx_batch_execute reads',
            '"batch". a namespace prefix (ctx, mcp) is dropped',
        ),
        detail: field(
            'detail',
            isBool,
            true,
            'give a tool that renders nothing but its name a subject and a quoted',
            'first line of whatever text it sends, with the rest on expand',
        ),
        execPreview: field(
            'exec-preview',
            isBool,
            true,
            'shorten ctx_execute / ctx_execute_file / ctx_batch_execute tool rows to',
            'one highlighted line each, expanding to the full command and output',
        ),
        names: field(
            'names',
            isStringRecord,
            {} as Record<string, string>,
            'display names for particular tools, as tool-name = "shown name".',
            'overrides the derivation, e.g. ctx_execute = "run"',
        ),
    },
} satisfies Schema;

export type RhoConfig = ConfigOf<typeof SCHEMA>;

// string-keyed view of SCHEMA, for the walks below.
const SECTIONS: Schema = SCHEMA;

// TOML name -> schema property, for reading a file back.
const SECTION_IDS: ReadonlyMap<string, string> = new Map(
    Object.keys(SCHEMA).map((identifier) => [tomlName(identifier), identifier]),
);

function defaults(): RhoConfig {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [section, fields] of Object.entries(SECTIONS)) {
        out[section] = {};
        for (const [name, f] of Object.entries(fields)) {
            // clone so a mutated array in `config` cannot reach DEFAULTS.
            out[section][name] = structuredClone(f.default);
        }
    }
    return out as RhoConfig;
}

type RawConfig = Record<string, unknown>;

export interface ConfigProblem {
    /** where in the file, e.g. `render.half-blocks` */
    at: string;
    message: string;
}

function describe(value: unknown): string {
    if (Array.isArray(value)) {
        const element = value[0];
        return element === undefined ? 'array' : `array of ${typeof element}`;
    }
    return typeof value;
}

// `half_blocks` and `halfBlocks` should be recognised as meaning `half-blocks`
// rather than silently ignored, so names are compared with separators and case
// removed.
function squash(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nearest(name: string, known: string[]): string | undefined {
    const target = squash(name);
    return known.find((candidate) => squash(candidate) === target);
}

function isTable(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * resolve a parsed TOML table against the schema. unknown or ill-typed entries
 * are reported and the field keeps its default, so a bad config degrades to the
 * default rather than propagating a value of the wrong type.
 */
export function resolveConfig(raw: RawConfig): {
    config: RhoConfig;
    problems: ConfigProblem[];
} {
    const out = defaults() as unknown as Record<string, Record<string, unknown>>;
    const problems: ConfigProblem[] = [];
    const sectionNames = [...SECTION_IDS.keys()];

    // a section written under any spelling that squashes to a known one still
    // applies, so a file holding the old `[sendNow]` keeps its settings instead
    // of silently falling back to the defaults; the problem list names the
    // spelling to move to.
    const tables = new Map<string, Record<string, unknown>>();
    for (const [name, value] of Object.entries(raw)) {
        const canonical = SECTION_IDS.has(name) ? name : nearest(name, sectionNames);
        if (canonical === undefined) {
            problems.push({
                at: name,
                message: `unknown section, ignored (known: ${sectionNames.join(', ')})`,
            });
            continue;
        }
        if (!isTable(value)) {
            problems.push({ at: name, message: `expected a [${name}] table, got ${describe(value)}` });
            continue;
        }
        if (canonical !== name) {
            problems.push({ at: name, message: `section is spelled [${canonical}]; the values were applied` });
        }
        tables.set(canonical, value);
    }

    for (const [section, fields] of Object.entries(SECTIONS)) {
        const rawSection = tables.get(tomlName(section));
        if (rawSection === undefined) continue;

        const keys = Object.values(fields).map((f) => f.key);
        const properties = new Map(Object.entries(fields).map(([name, f]) => [f.key, name]));
        const at = tomlName(section);

        // a key is resolved the way a section is: exact spelling first, then any
        // spelling that squashes to a known one, so `halfBlocks` and
        // `half_blocks` set `half-blocks` rather than being dropped.
        for (const [key, value] of Object.entries(rawSection)) {
            const canonical = properties.has(key) ? key : nearest(key, keys);
            if (canonical === undefined) {
                problems.push({ at: `${at}.${key}`, message: `unknown key, ignored (known: ${keys.join(', ')})` });
                continue;
            }
            const name = properties.get(canonical)!;
            const f = fields[name];
            if (!f.check(value)) {
                problems.push({
                    at: `${at}.${canonical}`,
                    message: `expected ${f.check.label}, got ${JSON.stringify(value)}; using default ${JSON.stringify(f.default)}`,
                });
                continue;
            }
            if (canonical !== key) {
                problems.push({ at: `${at}.${key}`, message: `key is spelled ${canonical}; the value was applied` });
            }
            out[section][name] = value;
        }
    }

    return { config: out as unknown as RhoConfig, problems };
}

function toRaw(cfg: RhoConfig): Record<string, Record<string, unknown>> {
    const live = cfg as unknown as Record<string, Record<string, unknown>>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [section, fields] of Object.entries(SECTIONS)) {
        const emitted: Record<string, unknown> = {};
        for (const [name, f] of Object.entries(fields)) {
            emitted[f.key] = live[section][name];
        }
        out[tomlName(section)] = emitted;
    }
    return out;
}

// a single short doc line rides on the assignment line itself, `key = value  #
// doc`, instead of costing it a line above. anything longer, or a doc with more
// than one line, still goes above: unlike an above comment, a trailing one has
// no room to wrap.
const MAX_LINE = 100;

// smol-toml emits `[section]` headers and `key = value` lines, so each field's
// doc is inserted at (trailing) or above that line.
function annotate(toml: string): string {
    const out: string[] = [];
    let fields: Section | undefined;

    for (const line of toml.split('\n')) {
        const header = line.match(/^\[([^\]]+)\]$/);
        if (header) {
            // a table-valued field is emitted as its own `[section.key]`
            // header rather than an assignment, so its doc goes above the
            // header; the keys under it are the reader's, and carry no doc.
            const [name, child] = header[1]!.split('.');
            const identifier = SECTION_IDS.get(name!);
            const section = identifier === undefined ? undefined : SECTIONS[identifier];
            if (child !== undefined) {
                const f = section && Object.values(section).find((candidate) => candidate.key === child);
                if (f) for (const doc of f.doc) out.push(`# ${doc}`);
                fields = undefined;
            } else {
                fields = section;
            }
            out.push(line);
            continue;
        }
        const assign = line.match(/^([A-Za-z0-9_-]+)\s*=/);
        const f = assign && fields && Object.values(fields).find((candidate) => candidate.key === assign[1]);
        if (f) {
            const trailing = `${line}  # ${f.doc[0]}`;
            if (f.doc.length === 1 && trailing.length <= MAX_LINE) {
                out.push(trailing);
                continue;
            }
            for (const doc of f.doc) out.push(`# ${doc}`);
        }
        out.push(line);
    }
    return out.join('\n');
}

function load(): { config: RhoConfig; problems: ConfigProblem[] } {
    if (!existsSync(CONFIG_PATH)) return { config: defaults(), problems: [] };
    let text: string;
    try {
        text = readFileSync(CONFIG_PATH, 'utf8');
    } catch (e) {
        return {
            config: defaults(),
            problems: [{ at: CONFIG_PATH, message: `could not be read: ${(e as Error).message}` }],
        };
    }
    try {
        return resolveConfig(parse(text) as RawConfig);
    } catch (e) {
        return {
            config: defaults(),
            problems: [
                { at: CONFIG_PATH, message: `is not valid TOML, using defaults: ${(e as Error).message}` },
            ],
        };
    }
}

const loaded = load();

export const DEFAULTS: Readonly<RhoConfig> = defaults();
export const config: RhoConfig = loaded.config;
/** anything wrong with the config file, surfaced by rho.ts at session start. */
export const configProblems: readonly ConfigProblem[] = loaded.problems;
export { CONFIG_PATH as configPath };

export function toToml(cfg: RhoConfig = config): string {
    return annotate(stringify(toRaw(cfg)));
}

/**
 * The comment block a config file opens with, blank line included, or '' when
 * it opens with a section.
 *
 * Everything below the first section header is generated and is replaced on
 * every `bun run config`. A note put above it is the one part of the file a
 * person wrote, so it is the one part a rewrite keeps.
 */
export function preamble(toml: string): string {
    const lines = toml.split('\n');
    let end = 0;
    while (end < lines.length) {
        const line = lines[end] as string;
        if (line.trim() !== '' && !line.trimStart().startsWith('#')) break;
        end += 1;
    }
    // A file that is nothing but comments has no generated part, so it has no
    // preamble either; taking all of it would double the file on the rewrite.
    if (end === lines.length) return '';
    return end === 0 ? '' : `${lines.slice(0, end).join('\n')}\n`;
}

export function save(path: string = CONFIG_PATH, cfg: RhoConfig = config): void {
    mkdirSync(dirname(path), { recursive: true });
    const kept = existsSync(path) ? preamble(readFileSync(path, 'utf8')) : '';
    writeFileSync(path, `${kept}${toToml(cfg)}`, 'utf8');
}
