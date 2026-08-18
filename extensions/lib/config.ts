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
    wordswap: {
        enabled: field(
            'enabled',
            isBool,
            true,
            'whether the word filter is active (toggle at runtime with /noswap)',
        ),
    },
    startup: {
        animate: field('animate', isBool, true, 'whether to play the logo animation on launch'),
    },
    images: {
        width: field('width', isPosInt, 180, 'width in terminal cells for inline images'),
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

// smol-toml emits `[section]` headers and `key = value` lines, so each field's
// doc is inserted above the line that assigns its key.
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
        if (assign && fields) {
            const f = Object.values(fields).find((candidate) => candidate.key === assign[1]);
            if (f) for (const doc of f.doc) out.push(`# ${doc}`);
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
