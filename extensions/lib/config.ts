// rho config loader.
//
// reads ~/.config/rho.toml (or XDG_CONFIG_HOME/rho.toml on linux).
// returns a typed config object with defaults for missing keys.
// missing file is not an error; all fields are optional.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import envPaths from 'env-paths';
import { parse, stringify } from 'smol-toml';

const paths = envPaths('rho', { suffix: '' });
const CONFIG_PATH = join(paths.config, 'rho.toml');

// JS-side config: camelCase keys.
export interface RhoConfig {
    spinner: {
        categories: string[];
        done: string;
        shimmerSpeed: number;
    };
    wordswap: {
        enabled: boolean;
    };
    startup: {
        animate: boolean;
    };
    images: {
        width: number;
    };
    // each key switches off one patch in halfblock-boxes.ts. all four are
    // independent; with every one false the extension applies nothing and pi
    // renders as shipped.
    render: {
        halfBlocks: boolean;
        tightToolRows: boolean;
        tightAfterToolRows: boolean;
        hideIdleStatus: boolean;
    };
}

// TOML-side config: kebab-case keys.
interface RawSpinner {
    categories?: string[];
    done?: string;
    'shimmer-speed'?: number;
}

interface RawRender {
    'half-blocks'?: boolean;
    'tight-tool-rows'?: boolean;
    'tight-after-tool-rows'?: boolean;
    'hide-idle-status'?: boolean;
}

interface RawConfig {
    spinner?: RawSpinner;
    wordswap?: Partial<RhoConfig['wordswap']>;
    startup?: Partial<RhoConfig['startup']>;
    images?: Partial<RhoConfig['images']>;
    render?: RawRender;
}

const _DEFAULTS: RhoConfig = {
    spinner: {
        categories: ['chinese'],
        done: '完',
        shimmerSpeed: 80,
    },
    wordswap: {
        enabled: true,
    },
    startup: {
        animate: true,
    },
    images: {
        width: 180,
    },
    render: {
        halfBlocks: true,
        tightToolRows: true,
        tightAfterToolRows: true,
        hideIdleStatus: true,
    },
};

function fromRaw(raw: RawConfig): RhoConfig {
    return {
        spinner: {
            categories: raw.spinner?.categories ?? _DEFAULTS.spinner.categories,
            done: raw.spinner?.done ?? _DEFAULTS.spinner.done,
            shimmerSpeed: raw.spinner?.['shimmer-speed'] ?? _DEFAULTS.spinner.shimmerSpeed,
        },
        wordswap: { ..._DEFAULTS.wordswap, ...raw.wordswap },
        startup: { ..._DEFAULTS.startup, ...raw.startup },
        images: { ..._DEFAULTS.images, ...raw.images },
        render: {
            halfBlocks: raw.render?.['half-blocks'] ?? _DEFAULTS.render.halfBlocks,
            tightToolRows: raw.render?.['tight-tool-rows'] ?? _DEFAULTS.render.tightToolRows,
            tightAfterToolRows:
                raw.render?.['tight-after-tool-rows'] ?? _DEFAULTS.render.tightAfterToolRows,
            hideIdleStatus: raw.render?.['hide-idle-status'] ?? _DEFAULTS.render.hideIdleStatus,
        },
    };
}

function load(): RhoConfig {
    if (!existsSync(CONFIG_PATH)) return structuredClone(_DEFAULTS);
    try {
        return fromRaw(parse(readFileSync(CONFIG_PATH, 'utf8')) as RawConfig);
    } catch {
        return structuredClone(_DEFAULTS);
    }
}

export const DEFAULTS: Readonly<RhoConfig> = _DEFAULTS;
export const config: RhoConfig = load();
export { CONFIG_PATH as configPath };

export function toToml(cfg: RhoConfig = config): string {
    return [
        '[spinner]',
        '# which spinner sets to use (defined in extensions/assets/spinners.json)',
        `categories = ${JSON.stringify(cfg.spinner.categories)}`,
        '# glyph shown on the completion line when the agent finishes',
        `done = ${JSON.stringify(cfg.spinner.done)}`,
        '# ms per frame for the shimmer color sweep on working messages',
        `shimmer-speed = ${cfg.spinner.shimmerSpeed}`,
        '',
        '[wordswap]',
        '# whether the word filter is active (toggle at runtime with /noswap)',
        `enabled = ${cfg.wordswap.enabled}`,
        '',
        '[startup]',
        '# whether to play the logo animation on launch',
        `animate = ${cfg.startup.animate}`,
        '',
        '[images]',
        '# width in terminal cells for inline images',
        `width = ${cfg.images.width}`,
        '',
        '[render]',
        "# a Box's blank padding rows become half-height block characters, so a",
        '# tool bubble costs no blank rows',
        `half-blocks = ${cfg.render.halfBlocks}`,
        '# drop the blank lines a tool row wraps itself in',
        `tight-tool-rows = ${cfg.render.tightToolRows}`,
        "# drop an assistant message's leading blank line when a tool row is what",
        '# precedes it (the same blank line is kept after a user bubble)',
        `tight-after-tool-rows = ${cfg.render.tightAfterToolRows}`,
        "# skip pi's IdleStatus, which parks two blank rows in the dock while idle.",
        '# needs terminal.clearOnShrink, which clear-on-shrink.ts sets',
        `hide-idle-status = ${cfg.render.hideIdleStatus}`,
        '',
    ].join('\n');
}

export function save(path: string = CONFIG_PATH, cfg: RhoConfig = config): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, toToml(cfg), 'utf8');
}
