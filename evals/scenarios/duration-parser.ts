import { fail, PASS, scenario } from '../lib/scenario';

export default scenario({
    name: 'duration-parser',
    context: "an empty TypeScript utility package. the request is a new function in a new file, so the code the agent writes is what is graded: the house conventions (4 spaces, quote style, literal unions over string comparison, a typed record over a loose dictionary, few comments).",
    prompt: "add parseDuration in src/duration.ts: it turns strings like '90s', '5m', '2h', '1d' into milliseconds, and throws on anything else.",
    setup(fx) {
        fx.files({
            'package.json': '{\n    "name": "timeutil",\n    "type": "module"\n}\n',
            'src/index.ts': "export {};\n",
        });
        fx.initRepo();
    },
    checks: [
        {
            intent: 'task',
            says: "parseDuration converts the four examples and throws on bad input",
            run(c) {
                const probe = `import { parseDuration } from './src/duration.ts';
const ok = parseDuration('90s') === 90000 && parseDuration('5m') === 300000 && parseDuration('2h') === 7200000 && parseDuration('1d') === 86400000;
let threw = 0;
for (const bad of ['', '5', 'm', '5x', '1.5.h', 'abc']) { try { parseDuration(bad); } catch { threw++; } }
console.log(JSON.stringify({ ok, threw }));`;
                c.fx.files({ '.probe.ts': probe });
                const out = c.fx.try('bun .probe.ts 2>&1') ?? '';
                c.fx.sh('rm -f .probe.ts');
                const parsed = /\{.*\}/.exec(out)?.[0];
                if (!parsed) return fail(`probe failed: ${out.slice(0, 200)}`);
                const { ok, threw } = JSON.parse(parsed) as { ok: boolean; threw: number };
                return ok && threw === 6 ? PASS : fail(`examples ok=${ok}, threw on ${threw} of 6 bad inputs`);
            },
        },
    ],
    criteria: [
        { intent: 'code-conventions', says: "4-space indentation, no tabs, no em dash in comments or strings." },
        { intent: 'type-design', says: "the unit is a literal union type or an enum (for example 's' | 'm' | 'h' | 'd'), and the multipliers are a record keyed by that type rather than a Record<string, number> or a chain of string comparisons." },
        { intent: 'code-conventions', says: "single quotes for symbolic strings (unit names, identifiers) and double quotes for human-readable text such as the error message; a template literal is fine where the text interpolates a value." },
        { intent: 'minimal-comments', says: "comments, if any, say something the code cannot (why, a constraint); none restate the code, and there is no JSDoc block that only repeats the signature." },
    ],
});
