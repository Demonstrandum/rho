// sets the working indicator and message. spinners come from spinners.json,
// filtered to ENABLED_CATEGORIES (chinese only by default); the message is a
// random line from maxims.txt. both refresh each turn.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// edit to switch spinner sets. categories are defined per spinner in spinners.json.
const ENABLED_CATEGORIES = ['chinese'];

interface SpinnerDef {
    category: string;
    interval: number;
    frames: string[];
}

type SpinnersFile = Record<string, SpinnerDef>;

const here = dirname(fileURLToPath(import.meta.url));
const spinnersPath = join(here, 'spinners.json');
const maximsPath = join(here, 'maxims.txt');

function loadSpinners(): SpinnerDef[] {
    const file = JSON.parse(readFileSync(spinnersPath, 'utf8')) as SpinnersFile;
    const enabled = new Set(ENABLED_CATEGORIES);
    const all = Object.values(file);
    const pool = all.filter((spinner) => enabled.has(spinner.category));
    return pool.length > 0 ? pool : all;
}

function loadMaxims(): string[] {
    return readFileSync(maximsPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith(';'));
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
            intervalMs: spinner.interval,
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
