import { test, expect } from 'bun:test';
import { resolveConfig, DEFAULTS, toToml } from '../extensions/lib/config';
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

test('a fractional value is rejected where the default is an integer', () => {
    const { config, problems } = resolveConfig({ spinner: { 'shimmer-speed': 1.5 } });
    expect(config.spinner.shimmerSpeed).toBe(DEFAULTS.spinner.shimmerSpeed);
    expect(problems).toHaveLength(1);
    // "expected number, got number" would say nothing here.
    expect(problems[0].message).toBe('expected integer, got 1.5; using default 80');
});

test('a misspelled key is reported with the intended key', () => {
    const cases = ['half_blocks', 'halfBlocks', 'Half-Blocks'];
    for (const key of cases) {
        const { problems } = resolveConfig({ render: { [key]: false } });
        expect(problems).toHaveLength(1);
        expect(problems[0].at).toBe(`render.${key}`);
        expect(problems[0].message).toBe('unknown key, did you mean half-blocks?');
    }
});

test('an unrecognisable key lists the known keys', () => {
    const { problems } = resolveConfig({ render: { nonsense: false } });
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('unknown key, ignored (known:');
    expect(problems[0].message).toContain('half-blocks');
});

test('a misspelled section is reported with the intended section', () => {
    const { problems } = resolveConfig({ Render: { 'half-blocks': false } });
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toBe('unknown section, did you mean [render]?');
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

test('what toToml writes, resolveConfig reads back unchanged', () => {
    const emitted = toToml(DEFAULTS);
    const { config, problems } = resolveConfig(parse(emitted) as Record<string, unknown>);
    // the emitted file must not itself trip the validator.
    expect(problems).toEqual([]);
    expect(config).toEqual(DEFAULTS);
});
