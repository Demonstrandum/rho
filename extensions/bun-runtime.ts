// rho runs under bun, and this is what enforces it.
//
// pi's launcher says `#!/usr/bin/env node`, so an unpatched install runs every
// extension in node. rho's code assumes bun: env-block.ts and lib/git-snapshot.ts
// call Bun.spawn, and under node that raises a ReferenceError which their catch
// reports as "no git repo". the failure is silent and the prompt states it as a
// fact about the directory, so a wrong runtime has to stop the session rather
// than degrade it.
//
// order of preference, and each step is only reached when the one before it fails:
//   1. running under bun already: do nothing, which is every normal session.
//   2. patch the launcher's shebang to bun, then re-run pi under bun with the
//      same arguments and exit with the child's status. the patch fixes future
//      launches; the re-run fixes this one, and it does not depend on the patch
//      having landed, since bun is invoked by path.
//   3. print a note naming what was tried and what stopped it, and exit 1.
//
// the extension factory runs while pi is still starting up, before the TUI owns
// the terminal, which is why writing to stderr and exiting is safe here and
// would not be from a later event.
//
// RHO_BUN_REEXEC marks the child. a child that arrives here again means something
// outside this file selects node (a wrapper script, a shell alias, PI_* config),
// and a second re-run would loop, so that case goes to the note.

import { spawnSync } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { bunBinary, describe, findLauncher, isBunRuntime, repairLaunchers, type Repair } from './lib/core/bun-launcher';
import { config } from './lib/core/config';

const REEXEC_MARKER = 'RHO_BUN_REEXEC';

const note = (reason: string, repairs: readonly Repair[]): void => {
    const bar = '─'.repeat(61);
    const lines = [
        bar,
        `rho: this pi is running under node ${process.versions.node}, not bun.`,
        '',
        'rho is built for bun. under node, the extensions that read the work',
        'tree fail and report the failure as "no git repo", so the session is',
        'stopped instead.',
        '',
        `could not switch runtime: ${reason}`,
    ];
    for (const repair of repairs) lines.push(`  ${describe(repair)}`);
    lines.push(
        '',
        'to fix it by hand, point pi\'s launcher at bun:',
        '  bun run doctor            report on the install',
        '  bun tools/bun-shebang.ts  rewrite the shebang',
        bar,
    );
    process.stderr.write(`\n${lines.join('\n')}\n\n`);
};

export default function (_pi: ExtensionAPI) {
    if (isBunRuntime()) return;
    if (!config.runtime.enforceBun) return;

    const launcher = findLauncher();
    const repairs = config.runtime.patchLauncher ? repairLaunchers(launcher) : [];
    const bun = bunBinary();

    if (!config.runtime.reexec) {
        note('reexec is off in rho.toml; run pi again to pick up the patched shebang', repairs);
        process.exit(1);
    }
    if (process.env[REEXEC_MARKER] === '1') {
        note('the re-run under bun came back as node, so something else selects node', repairs);
        process.exit(1);
    }
    if (bun === null) {
        note('bun is not on PATH: curl -fsSL https://bun.sh/install | bash', repairs);
        process.exit(1);
    }
    if (launcher === null) {
        note("pi's launcher script could not be located, so it cannot be re-run", repairs);
        process.exit(1);
    }

    const child = spawnSync(bun, [launcher, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, [REEXEC_MARKER]: '1' },
    });
    if (child.error !== undefined) {
        note(`${bun} could not be started: ${child.error.message}`, repairs);
        process.exit(1);
    }
    process.exit(child.status ?? 1);
}
