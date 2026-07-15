// idempotently persist a single nested value into pi's global settings.json.
// lives in a subdirectory so pi's extension auto-discovery (top-level *.ts
// only, subdirs need an index) does not try to load it as an extension.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function globalSettingsPath(): string {
    return join(getAgentDir(), 'settings.json');
}

function jsonEqual(a: Json | undefined, b: Json): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]!));
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => jsonEqual(a[k], b[k] as Json));
}

// ensure the nested key path holds `value`, writing the file only when it
// differs. returns true if a write happened. never stomps an unparseable file.
export function ensureGlobalSetting(keyPath: readonly [string, ...string[]], value: Json): boolean {
    const path = globalSettingsPath();
    let settings: Record<string, Json> = {};
    if (existsSync(path)) {
        try {
            settings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Json>;
        } catch {
            return false;
        }
    }

    let cursor: Record<string, Json> = settings;
    for (const key of keyPath.slice(0, -1)) {
        const next = cursor[key];
        if (next === null || typeof next !== 'object' || Array.isArray(next)) {
            cursor[key] = {};
        }
        cursor = cursor[key] as Record<string, Json>;
    }

    const leaf = keyPath[keyPath.length - 1]!;
    if (jsonEqual(cursor[leaf], value)) {
        return false;
    }
    cursor[leaf] = value;
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return true;
}
