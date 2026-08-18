// enable pi's terminal.clearOnShrink so no stale blank rows are left behind when
// the rendered content shrinks (e.g. the working indicator disappears at the end
// of a turn). pi's diff renderer only repaints changed lines; without a full
// redraw on shrink the now-unused bottom row lingers as an empty "footer" line.
//
// the extension API exposes no setter for this, and pi re-reads it from settings
// on every theme/settings re-apply, so a live-only flip gets clobbered. the
// durable fix is to persist terminal.clearOnShrink=true into the global settings
// once; footer.ts additionally flips it live so the very first session on a fresh
// machine is correct before the write lands.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

interface PiSettings {
    terminal?: { clearOnShrink?: boolean } & Record<string, unknown>;
    [key: string]: unknown;
}

// mirrors config.ts getAgentDir(): PI_CODING_AGENT_DIR overrides, else ~/.pi/agent.
function globalSettingsPath(): string {
    const envDir = process.env.PI_CODING_AGENT_DIR;
    if (envDir) {
        const expanded = envDir.startsWith('~') ? join(homedir(), envDir.slice(1)) : envDir;
        const base = isAbsolute(expanded) ? expanded : join(homedir(), expanded);
        return join(base, 'settings.json');
    }
    return join(homedir(), '.pi', 'agent', 'settings.json');
}

function ensureClearOnShrink(): void {
    const path = globalSettingsPath();
    let settings: PiSettings = {};
    if (existsSync(path)) {
        try {
            settings = JSON.parse(readFileSync(path, 'utf8')) as PiSettings;
        } catch {
            return; // never stomp a settings file we cannot parse.
        }
    }
    if (settings.terminal?.clearOnShrink === true) {
        return;
    }
    settings.terminal = { ...settings.terminal, clearOnShrink: true };
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode !== 'tui') {
            return;
        }
        try {
            ensureClearOnShrink();
        } catch {
            // best effort: a settings write failure should never break startup.
        }
    });
}
