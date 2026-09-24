import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import {
    clearOverride,
    clearOverrides,
    effectiveConfig,
    fieldState,
    loadOverrides,
    overrideStates,
    saveSession,
    setOverride,
} from '../extensions/lib/core/config';

afterEach(() => {
    clearOverrides();
});

test('an override is checked against the field type and names the field in TOML spelling', () => {
    const bad = setOverride('starfield.tools', 'yes');
    expect('error' in bad && bad.error).toContain('expects boolean');
    const ok = setOverride('starfield.tools', true);
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) {
        expect(ok.info.path).toEqual({ section: 'starfield', key: 'tools' });
        expect(ok.override).toBe(true);
    }
    // a spelling that squashes to a known one resolves to it.
    const squashed = setOverride('sendNow.send', 'ctrl+x');
    expect('error' in squashed || squashed.info.path).toEqual({ section: 'send-now', key: 'send' });
    expect(overrideStates().map((s) => `${s.info.path.section}.${s.info.path.key}`)).toEqual([
        'starfield.tools',
        'send-now.send',
    ]);
});

test('an unknown section or key is refused with the known names', () => {
    const noSection = fieldState('nope.x');
    expect('error' in noSection && noSection.error).toContain('unknown section');
    const noKey = setOverride('starfield.nope', 1);
    expect('error' in noKey && noKey.error).toContain('known: input');
});

test('the next load carries the overrides, and unset takes them back', () => {
    // the machine's own rho.toml is under the overrides, so compare with it.
    const before = effectiveConfig().ignition.styles;
    setOverride('ignition.styles', ['pulse']);
    expect(effectiveConfig().ignition.styles).toEqual(['pulse']);
    const state = fieldState('ignition.styles');
    expect('error' in state || state.pending).toBe(true);
    expect(clearOverride('ignition.styles')).toBe(true);
    expect(clearOverride('ignition.styles')).toBe(false);
    expect(effectiveConfig().ignition.styles).toEqual(before);
});

test('save --changes merges only the overrides into what the file holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rho-config-'));
    const file = join(dir, 'stars.toml');
    writeFileSync(file, '# mine\n\n[starfield]\ndensity = 3\n');
    setOverride('starfield.tools', true);
    setOverride('ignition.enabled', true);
    saveSession(file, 'changes');
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('# mine\n')).toBe(true);
    expect(parse(text)).toEqual({ starfield: { density: 3, tools: true }, ignition: { enabled: true } });

    clearOverrides();
    const loaded = loadOverrides(file);
    expect(loaded.problems).toEqual([]);
    expect(loaded.set.sort()).toEqual(['ignition.enabled', 'starfield.density', 'starfield.tools']);
});

test('save all writes every field as the next load would see it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rho-config-'));
    const file = join(dir, 'all.toml');
    setOverride('starfield.input', 'turn');
    saveSession(file, 'all');
    const written = parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(written.starfield!.input).toBe('turn');
    expect(Object.keys(written)).toContain('spinner');
});

test('a file with a bad value loads the rest and reports the one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rho-config-'));
    const file = join(dir, 'bad.toml');
    writeFileSync(file, '[starfield]\ntools = "yes"\ninput = "session"\n');
    const loaded = loadOverrides(file);
    expect(loaded.set).toEqual(['starfield.input']);
    expect(loaded.problems.map((p) => p.at)).toEqual(['starfield.tools']);
});
