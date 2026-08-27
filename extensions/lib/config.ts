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
    cwd: {
        remember: field(
            'remember',
            isBool,
            true,
            'store where /cwd last pointed for this session and return there on a',
            'resume, when the directory still exists',
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
            'what happens after a checkpoint fails. disable-session: report the',
            'first failure and take no further checkpoint for the rest of the',
            'session, since the cause (an unreadable path, a work tree too large',
            'to stage inside the two-minute timeout) does not change while the',
            'session runs. keep-trying: pi-rewind\'s own behaviour, one attempt',
            'and one warning per turn',
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
        hideIdleStatus: field(
            'hide-idle-status',
            isBool,
            true,
            "skip pi's IdleStatus, which parks two blank rows in the dock while idle.",
            'needs terminal.clearOnShrink, which clear-on-shrink.ts sets',
        ),
        execPreview: field(
            'exec-preview',
            isBool,
            true,
            'shorten ctx_execute / ctx_execute_file / ctx_batch_execute tool rows to',
            'one highlighted line each, expanding to the full command and output',
        ),
    },
} satisfies Schema;

export type RhoConfig = ConfigOf<typeof SCHEMA>;

// string-keyed view of SCHEMA, for the walks below.
const SECTIONS: Schema = SCHEMA;

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
    const sectionNames = Object.keys(SECTIONS);

    for (const [name, value] of Object.entries(raw)) {
        if (!(name in SECTIONS)) {
            const suggestion = nearest(name, sectionNames);
            problems.push({
                at: name,
                message: suggestion
                    ? `unknown section, did you mean [${suggestion}]?`
                    : `unknown section, ignored (known: ${sectionNames.join(', ')})`,
            });
            continue;
        }
        if (!isTable(value)) {
            problems.push({ at: name, message: `expected a [${name}] table, got ${describe(value)}` });
        }
    }

    for (const [section, fields] of Object.entries(SECTIONS)) {
        const rawSection = raw[section];
        if (!isTable(rawSection)) continue;

        const keys = Object.values(fields).map((f) => f.key);
        for (const key of Object.keys(rawSection)) {
            if (keys.includes(key)) continue;
            const suggestion = nearest(key, keys);
            problems.push({
                at: `${section}.${key}`,
                message: suggestion
                    ? `unknown key, did you mean ${suggestion}?`
                    : `unknown key, ignored (known: ${keys.join(', ')})`,
            });
        }

        for (const [name, f] of Object.entries(fields)) {
            const value = rawSection[f.key];
            if (value === undefined) continue;
            if (!f.check(value)) {
                problems.push({
                    at: `${section}.${f.key}`,
                    message: `expected ${f.check.label}, got ${JSON.stringify(value)}; using default ${JSON.stringify(f.default)}`,
                });
                continue;
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
        out[section] = emitted;
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
            fields = SECTIONS[header[1]];
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

export function save(path: string = CONFIG_PATH, cfg: RhoConfig = config): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, toToml(cfg), 'utf8');
}
