// idempotently move a built-in action onto other keys in pi's global
// keybindings.json. lives in a subdirectory so extension auto-discovery
// (top-level *.ts only) does not load it as an extension.
//
// an extension shortcut that shares a key with any built-in action produces a
// startup diagnostic ("Extension shortcut conflict: ... Using <extension>"),
// printed even under quietStartup, since showLoadedResources is called with
// showDiagnosticsWhenQuiet: true. the extension handler does win, and only in
// the main editor, so the report is noise. moving the built-in off the key is
// what removes it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type AppKeybinding } from '@earendil-works/pi-coding-agent';
import { getKeybindings, type Keybinding, type KeyId } from '@earendil-works/pi-tui';

// pi's own ids (app.*) plus the shared tui.* ones. a keybindings.json file can
// carry either.
export type KeybindingId = AppKeybinding | Keybinding;

type Bindings = Record<string, KeyId | KeyId[] | undefined>;

function keybindingsPath(): string {
    return join(getAgentDir(), 'keybindings.json');
}

// write `keys` for `id` unless the file already says something about `id`, so a
// binding the user chose is never overwritten. returns true if a write happened.
// every action currently bound to `key`, from the resolved config (defaults plus
// whatever keybindings.json says). the global manager is set by pi before
// extensions load; an empty map is returned if it is not there yet, which makes
// the caller a no-op rather than a crash.
export function actionsBoundTo(key: KeyId): { ids: KeybindingId[]; keysInUse: Set<string> } {
    const ids: KeybindingId[] = [];
    const keysInUse = new Set<string>();
    let resolved: Record<string, KeyId | KeyId[] | undefined>;
    try {
        resolved = getKeybindings().getResolvedBindings();
    } catch {
        return { ids, keysInUse };
    }

    // getKeybindings() lazily makes a tui-only manager when pi has not set one
    // yet. that map has no app.* ids, so it cannot tell which built-in actions
    // hold a key, and reporting no collisions from it would be wrong.
    if (!Object.keys(resolved).some((id) => id.startsWith('app.'))) {
        return { ids, keysInUse };
    }

    const target = key.toLowerCase();
    for (const [id, bound] of Object.entries(resolved)) {
        if (bound === undefined) continue;
        const list = (Array.isArray(bound) ? bound : [bound]).map((k) => k.toLowerCase());
        for (const k of list) keysInUse.add(k);
        if (list.includes(target)) ids.push(id as KeybindingId);
    }
    return { ids, keysInUse };
}

export function ensureKeybinding(id: KeybindingId, keys: KeyId | readonly KeyId[]): boolean {
    const path = keybindingsPath();
    let bindings: Bindings = {};
    if (existsSync(path)) {
        try {
            bindings = JSON.parse(readFileSync(path, 'utf8')) as Bindings;
        } catch {
            return false;
        }
    }
    if (id in bindings) {
        return false;
    }

    bindings[id] = Array.isArray(keys) ? [...keys] : (keys as KeyId);
    try {
        mkdirSync(getAgentDir(), { recursive: true });
        writeFileSync(path, `${JSON.stringify(bindings, null, 2)}\n`, 'utf8');
    } catch {
        return false;
    }
    return true;
}
