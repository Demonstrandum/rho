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

type RawConfig = Record<string, Record<string, unknown> | undefined>;

function fromRaw(raw: RawConfig): RhoConfig {
    const out = defaults() as unknown as Record<string, Record<string, unknown>>;
    for (const [section, fields] of Object.entries(SECTIONS)) {
        const rawSection = raw[section];
        if (!rawSection) continue;
        for (const [name, f] of Object.entries(fields)) {
            const value = rawSection[f.key];
            if (value !== undefined) out[section][name] = value;
        }
    }
    return out as unknown as RhoConfig;
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

function load(): RhoConfig {
    if (!existsSync(CONFIG_PATH)) return defaults();
    try {
        return fromRaw(parse(readFileSync(CONFIG_PATH, 'utf8')) as RawConfig);
    } catch {
        return defaults();
    }
}

export const DEFAULTS: Readonly<RhoConfig> = defaults();
export const config: RhoConfig = load();
export { CONFIG_PATH as configPath };

export function toToml(cfg: RhoConfig = config): string {
    return annotate(stringify(toRaw(cfg)));
}

export function save(path: string = CONFIG_PATH, cfg: RhoConfig = config): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, toToml(cfg), 'utf8');
}
