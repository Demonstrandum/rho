// sets the working indicator and message. spinners come from spinners.json
// (filtered to spinners.json enabledCategories, default chinese only) and the
// message is a random line from maxims.txt. both refresh each turn.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

interface Spinner {
    name: string;
    category: string;
    intervalMs: number;
    frames: string[];
}

interface SpinnersConfig {
    enabledCategories: string[];
    spinners: Spinner[];
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spinnersPath = join(root, 'spinners.json');
const maximsPath = join(root, 'maxims.txt');

function loadSpinners(): Spinner[] {
    const config = JSON.parse(readFileSync(spinnersPath, 'utf8')) as SpinnersConfig;
    const enabled = new Set(config.enabledCategories);
    const pool = config.spinners.filter((spinner) => enabled.has(spinner.category));
    return pool.length > 0 ? pool : config.spinners;
}

function loadMaxims(): string[] {
    return readFileSync(maximsPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function pick<T>(items: T[]): T | undefined {
    return items.length > 0 ? items[Math.floor(Math.random() * items.length)] : undefined;
}

function apply(ctx: ExtensionContext): void {
    const spinner = pick(loadSpinners());
    const maxim = pick(loadMaxims());
    if (maxim !== undefined) {
        ctx.ui.setWorkingMessage(ctx.ui.theme.fg('accent', maxim));
    }
    if (spinner !== undefined) {
        ctx.ui.setWorkingIndicator({
            frames: spinner.frames.map((frame) => ctx.ui.theme.fg('accent', frame)),
            intervalMs: spinner.intervalMs,
        });
    }
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        apply(ctx);
    });
    pi.on('turn_start', async (_event, ctx) => {
        apply(ctx);
    });
}
