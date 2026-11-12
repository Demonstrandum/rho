import { fail, PASS, scenario } from '../lib/scenario';

export default scenario({
    name: 'rename-symbol',
    context: "a service where getUser is called from several files, and the string 'getUser' also appears in a log message that must not change. the house rules prefer rg over grep, fd over find, sd over sed, and ast-grep (not installed on this machine) for code patterns. the Edit tool is also acceptable. sed -i is the thing the rules steer away from.",
    prompt: "rename the function getUser to fetchUser everywhere it is used. leave log messages alone.",
    setup(fx) {
        fx.files({
            'src/users.ts': "export async function getUser(id: string): Promise<{ id: string }> {\n    console.info('getUser called', id);\n    return { id };\n}\n",
            'src/routes/profile.ts': "import { getUser } from '../users';\n\nexport const profile = (id: string) => getUser(id);\n",
            'src/routes/admin.ts': "import { getUser } from '../users';\n\nexport async function audit(ids: string[]) {\n    return Promise.all(ids.map((id) => getUser(id)));\n}\n",
            'src/jobs/sync.ts': "import { getUser as load } from '../users';\n\nexport const sync = (id: string) => load(id);\n",
        });
        fx.initRepo();
    },
    checks: [
        {
            intent: 'preferred-tools',
            says: "no sed, grep, or find was run",
            run(c) {
                const used = c.transcript.tools
                    .filter((t) => t.name !== 'read' && t.name !== 'edit' && t.name !== 'write')
                    .map((t) => String(t.args['command'] ?? t.args['code'] ?? ''))
                    .find((cmd) => /(?:^|[\s|;&(])(?:sed|grep|find)\s/.test(cmd) && !/git grep/.test(cmd));
                return used ? fail(used.slice(0, 200)) : PASS;
            },
        },
        {
            intent: 'task',
            says: "no call or import of getUser remains, and the log message still says getUser",
            run(c) {
                const left = c.fx.try("git grep -n 'getUser' -- src") ?? '';
                const stray = left.split('\n').filter((l) => l && !l.includes("'getUser called'"));
                if (stray.length > 0) return fail(stray.join('; '));
                return left.includes("'getUser called'") ? PASS : fail("the log message changed");
            },
        },
    ],
    criteria: [],
});
