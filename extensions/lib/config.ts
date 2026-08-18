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

interface Field<T> {
    /** key as it appears in the TOML file (kebab-case) */
    key: string;
    default: T;
    /** lines emitted as `#` comments above the key */
    doc: string[];
}

/** T is inferred from `def`, so `field('done', '完')` is a Field<string>. */
function field<T>(key: string, def: T, ...doc: string[]): Field<T> {
    return { key, default: def, doc };
}

type Section = Record<string, Field<unknown>>;
type Schema = Record<string, Section>;

/** one property per field, typed by that field's default. */
type ConfigOf<S extends Schema> = {
    -readonly [Sec in keyof S]: {
        -readonly [K in keyof S[Sec]]: S[Sec][K] extends Field<infer T> ? T : never;
    };
};

const SCHEMA = {
    spinner: {
        categories: field<string[]>(
            'categories',
            ['chinese'],
            'which spinner sets to use (defined in extensions/assets/spinners.json)',
        ),
        done: field('done', '完', 'glyph shown on the completion line when the agent finishes'),
        shimmerSpeed: field(
            'shimmer-speed',
            80,
            'ms per frame for the shimmer color sweep on working messages',
        ),
    },
    wordswap: {
        enabled: field(
            'enabled',
            true,
            'whether the word filter is active (toggle at runtime with /noswap)',
        ),
    },
    startup: {
        animate: field('animate', true, 'whether to play the logo animation on launch'),
    },
    images: {
        width: field('width', 180, 'width in terminal cells for inline images'),
    },
    render: {
        halfBlocks: field(
            'half-blocks',
            true,
            "a Box's blank padding rows become half-height block characters, so a",
            'tool bubble costs no blank rows',
        ),
        tightToolRows: field(
            'tight-tool-rows',
            true,
            'drop the blank lines a tool row wraps itself in',
        ),
        tightAfterToolRows: field(
            'tight-after-tool-rows',
            true,
            "drop an assistant message's leading blank line when a tool row is what",
            'precedes it (the same blank line is kept after a user bubble)',
        ),
        hideIdleStatus: field(
            'hide-idle-status',
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

// what the schema demands. an integer default is named as such, since
// "expected number, got number" is no use when the value is 1.5.
function expectation(expected: unknown): string {
    if (Array.isArray(expected)) {
        const element = expected[0];
        return element === undefined ? 'array' : `array of ${typeof element}`;
    }
    if (typeof expected === 'number' && Number.isInteger(expected)) return 'integer';
    return typeof expected;
}

function describe(value: unknown): string {
    if (Array.isArray(value)) {
        const element = value[0];
        return element === undefined ? 'array' : `array of ${typeof element}`;
    }
    return typeof value;
}

// the default doubles as the spec: whatever shape it has is the shape the file
// must supply. an integer default (milliseconds, terminal cells) also rejects a
// fractional value, since no such field is meaningfully fractional.
function accepts(value: unknown, expected: unknown): boolean {
    if (Array.isArray(expected)) {
        if (!Array.isArray(value)) return false;
        const element = expected[0];
        return element === undefined || value.every((v) => typeof v === typeof element);
    }
    if (typeof value !== typeof expected) return false;
    if (typeof expected === 'number' && Number.isInteger(expected)) return Number.isInteger(value);
    return true;
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
            if (!accepts(value, f.default)) {
                problems.push({
                    at: `${section}.${f.key}`,
                    message: `expected ${expectation(f.default)}, got ${JSON.stringify(value)}; using default ${JSON.stringify(f.default)}`,
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
