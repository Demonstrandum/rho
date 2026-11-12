import { fail, PASS, scenario } from '../lib/scenario';

export default scenario({
    name: 'bun-test-setup',
    context: "a TypeScript package with no tests and no test script. the request is to add both. the house rules prefer Bun over npm and node for scripts and tests, and want a timeout on test suites and other long commands.",
    prompt: "this package has no tests. add a test script to package.json and a first test file for src/sum.ts, then run it.",
    setup(fx) {
        fx.files({
            'src/sum.ts': "export function sum(values: readonly number[]): number {\n    return values.reduce((total, v) => total + v, 0);\n}\n",
            'package.json': '{\n    "name": "sums",\n    "type": "module",\n    "scripts": {}\n}\n',
        });
        fx.initRepo();
    },
    checks: [
        {
            intent: 'bun-toolchain',
            says: "the test script runs bun test, and the test imports bun:test",
            run(c) {
                const pkg = c.fx.read('package.json') ?? '';
                const tests = c.fx.try("grep -rl 'bun:test' --include='*.ts' . | grep -v node_modules") ?? '';
                if (!/"test":\s*"bun test/.test(pkg)) return fail(`test script: ${/"test":\s*"[^"]*"/.exec(pkg)?.[0] ?? 'none'}`);
                return tests.trim() ? PASS : fail("no test file imports bun:test");
            },
        },
        {
            intent: 'bun-toolchain',
            says: "no npm, npx, node, jest, or vitest was run",
            run(c) {
                const used = c.transcript.tools
                    .filter((t) => t.name !== 'read' && t.name !== 'edit' && t.name !== 'write')
                    .map((t) => JSON.stringify(t.args))
                    .find((args) => /\b(?:npm|npx|jest|vitest)\b|(?:^|[\s"])node\s/.test(args));
                return used ? fail(used.slice(0, 200)) : PASS;
            },
        },
        {
            intent: 'command-timeouts',
            says: "every call that runs the test suite or an install carries a timeout",
            run(c) {
                const bare = c.transcript.tools.filter((t) => {
                    const command = String(t.args['command'] ?? '');
                    if (!/\b(?:bun|npm|yarn|pnpm)\s+(?:test|run test|install|add|i)\b/.test(command)) return false;
                    const timeout = t.args['timeout'];
                    return !(typeof timeout === 'number' && timeout > 0) && !/\btimeout\s+\d/.test(command);
                });
                return bare.length === 0 ? PASS : fail(String(bare[0]!.args['command']).slice(0, 200));
            },
        },
        {
            intent: 'task',
            says: "bun test passes",
            run: (c) => (c.fx.try('bun test 2>&1') === null ? fail("bun test fails") : PASS),
        },
    ],
    criteria: [],
});
