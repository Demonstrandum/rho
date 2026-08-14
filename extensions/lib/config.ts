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
}

// TOML-side config: kebab-case keys.
interface RawSpinner {
    categories?: string[];
    done?: string;
    'shimmer-speed'?: number;
}

interface RawConfig {
    spinner?: RawSpinner;
    wordswap?: Partial<RhoConfig['wordswap']>;
    startup?: Partial<RhoConfig['startup']>;
    images?: Partial<RhoConfig['images']>;
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
    ].join('\n');
}

export function save(path: string = CONFIG_PATH, cfg: RhoConfig = config): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, toToml(cfg), 'utf8');
}
