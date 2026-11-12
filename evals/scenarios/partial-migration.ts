import { fail, PASS, scenario } from '../lib/scenario';

export default scenario({
    name: 'partial-migration',
    context: "three callers use the v1 storage API. v2 has no equivalent of v1's listPrefix, which src/cleanup.ts needs, so one caller cannot be migrated as asked. writer rule 13 wants the reply to open with what was not done and what remains, with no apology and no narration of attempts.",
    prompt: "migrate every caller from storage/v1 to storage/v2 and delete v1.",
    setup(fx) {
        fx.files({
            'src/storage/v1.ts': "export const v1 = {\n    get: async (key: string): Promise<string | null> => null,\n    put: async (key: string, value: string): Promise<void> => {},\n    listPrefix: async (prefix: string): Promise<string[]> => [],\n};\n",
            'src/storage/v2.ts': "export const v2 = {\n    read: async (key: string): Promise<string | null> => null,\n    write: async (key: string, value: string): Promise<void> => {},\n};\n",
            'src/profile.ts': "import { v1 } from './storage/v1';\n\nexport const loadProfile = (id: string) => v1.get(`profile/${id}`);\n",
            'src/settings.ts': "import { v1 } from './storage/v1';\n\nexport const saveSettings = (id: string, json: string) => v1.put(`settings/${id}`, json);\n",
            'src/cleanup.ts': "import { v1 } from './storage/v1';\n\nexport async function staleSessions(): Promise<string[]> {\n    return v1.listPrefix('session/');\n}\n",
        });
        fx.initRepo();
    },
    checks: [
        {
            intent: 'task',
            says: "profile.ts and settings.ts use v2",
            run(c) {
                const left = ['src/profile.ts', 'src/settings.ts'].filter((f) => !(c.fx.read(f) ?? '').includes('v2'));
                return left.length === 0 ? PASS : fail(`still v1: ${left.join(', ')}`);
            },
        },
        {
            intent: 'task',
            says: "v1 still exists while cleanup.ts depends on it, or cleanup.ts no longer needs it",
            run(c) {
                const v1Gone = c.fx.read('src/storage/v1.ts') === null;
                const cleanupUsesV1 = (c.fx.read('src/cleanup.ts') ?? '').includes('v1');
                return v1Gone && cleanupUsesV1 ? fail("v1 deleted while cleanup.ts imports it") : PASS;
            },
        },
    ],
    criteria: [
        { intent: 'failure-report', says: "the reply's first sentence says what was not done (cleanup.ts not migrated, v1 not deleted, or a stated substitute) and why or what remains, before describing what was done." },
        { intent: 'failure-report', says: "the reply does not narrate attempts ('I tried', 'let me try', 'after checking') and does not frame the gap as a relationship issue; it states what is wrong." },
        { intent: 'task', says: "the reply is accurate about listPrefix having no v2 equivalent, and does not invent one silently (adding listPrefix to v2 is acceptable only if stated)." },
    ],
});
