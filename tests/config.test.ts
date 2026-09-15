import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    resolveConfig,
    DEFAULTS,
    toToml,
    isBool,
    isString,
    isPosInt,
    isStringArray,
    isOneOf,
    tomlName,
} from '../extensions/lib/config';
import { parse } from 'smol-toml';

test('a valid value is taken from the file', () => {
    const { config, problems } = resolveConfig({ render: { 'half-blocks': false } });
    expect(config.render.halfBlocks).toBe(false);
    expect(problems).toEqual([]);
});

test('omitted keys and absent sections fall back to defaults', () => {
    const { config, problems } = resolveConfig({ render: { 'half-blocks': false } });
    expect(config.render.tightToolRows).toBe(true);
    expect(config.images.width).toBe(DEFAULTS.images.width);
    expect(problems).toEqual([]);
});

test('a wrong type is rejected, keeps the default, and is reported', () => {
    const { config, problems } = resolveConfig({
        render: { 'half-blocks': 'yes' },
        spinner: { 'shimmer-speed': 'fast', categories: 3, done: 42 },
        images: { width: true },
    });
    // the declared type must hold at runtime, not just at compile time.
    expect(config.render.halfBlocks).toBe(true);
    expect(config.spinner.shimmerSpeed).toBe(DEFAULTS.spinner.shimmerSpeed);
    expect(config.spinner.categories).toEqual(DEFAULTS.spinner.categories);
    expect(config.spinner.done).toBe(DEFAULTS.spinner.done);
    expect(config.images.width).toBe(DEFAULTS.images.width);

    expect(problems).toHaveLength(5);
    for (const p of problems) console.log(`${p.at}: ${p.message}`);
    // the message names the offending value, not just its type.
    expect(problems.find((p) => p.at === 'render.half-blocks')?.message).toContain(
        'expected boolean, got "yes"',
    );
    expect(problems.find((p) => p.at === 'spinner.categories')?.message).toContain(
        'expected array of string, got 3',
    );
});

test('an array of the wrong element type is rejected', () => {
    const { config, problems } = resolveConfig({ spinner: { categories: ['ok', 7] } });
    expect(config.spinner.categories).toEqual(DEFAULTS.spinner.categories);
    expect(problems).toHaveLength(1);
});

test('an empty array is accepted', () => {
    const { config, problems } = resolveConfig({ spinner: { categories: [] } });
    expect(config.spinner.categories).toEqual([]);
    expect(problems).toEqual([]);
});

test('every schema field is checked, so the emitted file names each expectation', () => {
    // guards are the only source of the "expected ..." text, so a field added
    // without one would surface here rather than silently accepting anything.
    const labels = new Set([
        isBool.label,
        isString.label,
        isPosInt.label,
        isStringArray.label,
        isOneOf('context', 'transcript', 'both').label,
    ]);
    const { problems } = resolveConfig({
        spinner: { categories: 1, done: 1, 'shimmer-speed': 'x' },
        audit: {
            model: 1,
            feedback: 'somewhere',
            'timeout-ms': 'x',
            audience: 1,
        },
        wordswap: { enabled: 1 },
        startup: { animate: 1 },
        images: { width: 'x' },
        render: {
            'half-blocks': 1,
            'tight-tool-rows': 1,
            'tight-after-tool-rows': 1,
            'hide-idle-status': 1,
        },
    });
    // one per field in the schema
    expect(problems).toHaveLength(14);
    for (const p of problems) {
        const named = [...labels].some((l) => p.message.includes(`expected ${l}`));
        expect(named).toBe(true);
    }
});

test('a fractional value is rejected where a positive integer is required', () => {
    const { config, problems } = resolveConfig({ spinner: { 'shimmer-speed': 1.5 } });
    expect(config.spinner.shimmerSpeed).toBe(DEFAULTS.spinner.shimmerSpeed);
    expect(problems).toHaveLength(1);
    // "expected number, got number" would say nothing here.
    expect(problems[0].message).toBe('expected positive integer, got 1.5; using default 80');
});

test('a constraint narrower than the type is enforced', () => {
    // no default could express "positive": -5 and 0 are both plain numbers.
    for (const bad of [-5, 0]) {
        const { config, problems } = resolveConfig({ spinner: { 'shimmer-speed': bad } });
        expect(config.spinner.shimmerSpeed).toBe(DEFAULTS.spinner.shimmerSpeed);
        expect(problems).toHaveLength(1);
        expect(problems[0].message).toContain('expected positive integer');
    }
});

test('guards check exactly, with no sample value to infer from', () => {
    // the empty-array case: element checking must not depend on a default
    // supplying an element to compare against.
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray([1, 2])).toBe(false);
    expect(isStringArray(['a', 7])).toBe(false);
    expect(isStringArray('a')).toBe(false);

    expect(isPosInt(80)).toBe(true);
    expect(isPosInt(0)).toBe(false);
    expect(isPosInt(-1)).toBe(false);
    expect(isPosInt(1.5)).toBe(false);
    expect(isPosInt('80')).toBe(false);

    expect(isBool(true)).toBe(true);
    expect(isBool('true')).toBe(false);

    expect(isString('')).toBe(true);
    expect(isString(42)).toBe(false);

    // a closed set: membership, not shape, is what a literal union constrains.
    const feedback = isOneOf('context', 'transcript', 'both');
    expect(feedback('both')).toBe(true);
    expect(feedback('Both')).toBe(false);
    expect(feedback('somewhere')).toBe(false);
    expect(feedback(1)).toBe(false);
});

test('a value outside a closed set keeps the default and lists the members', () => {
    const { config, problems } = resolveConfig({ audit: { feedback: 'somewhere' } });
    expect(config.audit.feedback).toBe(DEFAULTS.audit.feedback);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toBe(
        'expected "context" | "transcript" | "both", got "somewhere"; using default "both"',
    );
});

test('every guard carries a label used in messages', () => {
    expect(isBool.label).toBe('boolean');
    expect(isString.label).toBe('string');
    expect(isPosInt.label).toBe('positive integer');
    expect(isStringArray.label).toBe('array of string');
    expect(isOneOf('a', 'b').label).toBe('"a" | "b"');
});

test('a key spelled another way still sets its field, and says so', () => {
    const cases = ['half_blocks', 'halfBlocks', 'Half-Blocks'];
    for (const key of cases) {
        const { config, problems } = resolveConfig({ render: { [key]: false } });
        expect(config.render.halfBlocks).toBe(false);
        expect(problems).toHaveLength(1);
        expect(problems[0].at).toBe(`render.${key}`);
        expect(problems[0].message).toBe('key is spelled half-blocks; the value was applied');
    }
});

test('an unrecognisable key lists the known keys', () => {
    const { problems } = resolveConfig({ render: { nonsense: false } });
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('unknown key, ignored (known:');
    expect(problems[0].message).toContain('half-blocks');
});

test('a section spelled another way still applies, and says so', () => {
    const { config, problems } = resolveConfig({ Render: { 'half-blocks': false } });
    expect(config.render.halfBlocks).toBe(false);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toBe('section is spelled [render]; the values were applied');
});

test('a camelCase section identifier is written and read as kebab-case', () => {
    expect(tomlName('sendNow')).toBe('send-now');
    expect(tomlName('render')).toBe('render');
    expect(toToml(DEFAULTS)).toContain('[send-now]');
    expect(toToml(DEFAULTS)).not.toContain('[sendNow]');

    // the old spelling keeps working, so an existing file loses no settings.
    const { config, problems } = resolveConfig({ sendNow: { send: 'ctrl+j' } });
    expect(config.sendNow.send).toBe('ctrl+j');
    expect(problems[0].message).toBe('section is spelled [send-now]; the values were applied');
});

test('the whole emitted file is kebab-case, sections and keys alike', () => {
    const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    const emitted = parse(toToml(DEFAULTS)) as Record<string, Record<string, unknown>>;

    for (const [section, table] of Object.entries(emitted)) {
        expect(section).toMatch(kebab);
        for (const key of Object.keys(table)) expect(key).toMatch(kebab);
    }
});

test('an unknown section is reported and ignored', () => {
    const { config, problems } = resolveConfig({ renderer: { 'half-blocks': false } });
    expect(config.render.halfBlocks).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0].at).toBe('renderer');
});

test('a section that is not a table is reported', () => {
    const { problems } = resolveConfig({ render: 5 });
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('expected a [render] table, got number');
});

test('defaults are not aliased, so a mutated config cannot reach them', () => {
    const { config } = resolveConfig({});
    config.spinner.categories.push('mutated');
    expect(DEFAULTS.spinner.categories).not.toContain('mutated');
});

// rho.toml at the repo root is generated output, not a file anyone edits: it is
// this schema printed with its docs. a field added here without `bun run config`
// leaves the two disagreeing, and a hand-written line there is lost on the next
// run, so the file is pinned to what toToml emits.
test('the rho.toml in the repo is what toToml generates', () => {
    const root = join(import.meta.dir, '..');
    expect(readFileSync(join(root, 'rho.toml'), 'utf8')).toBe(toToml(DEFAULTS));
});

test('what toToml writes, resolveConfig reads back unchanged', () => {
    const emitted = toToml(DEFAULTS);
    const { config, problems } = resolveConfig(parse(emitted) as Record<string, unknown>);
    // the emitted file must not itself trip the validator.
    expect(problems).toEqual([]);
    expect(config).toEqual(DEFAULTS);
});
