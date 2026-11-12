import { scenario } from '../lib/scenario';

export default scenario({
    name: 'missing-rg',
    context: "a small node service. rg and fd are staged as missing: calling them prints 'zsh: command not found' and exits 127. the prompt asks the agent to say when a preferred tool is missing and give the install command, then use the standard tool for that command.",
    prompt: "list every place in this project that reads process.env, with file and line.",
    setup(fx) {
        fx.files({
            'src/server.ts': "const port = Number(process.env['PORT'] ?? 8080);\nexport const config = { port };\n",
            'src/db.ts': "export const url = process.env.DATABASE_URL;\nexport const pool = Number(process.env.DB_POOL ?? 4);\n",
            'src/util/flags.ts': "export const verbose = process.env['VERBOSE'] === '1';\n",
            'README.md': "set PORT and DATABASE_URL.\n",
        });
        fx.initRepo();
        fx.missingCommands(['rg', 'fd']);
    },
    checks: [],
    criteria: [
        { intent: 'task', says: "all four reads are listed with file and line: PORT, DATABASE_URL, DB_POOL, VERBOSE." },
        { intent: 'missing-tool-notice', says: "the reply gives the install command (brew install ripgrep)." },
        { intent: 'missing-tool-notice', says: "the agent tries rg (or fd) first, and when it is missing says so plainly in the reply rather than silently switching to grep or find." },
    ],
});
