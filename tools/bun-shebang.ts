#!/usr/bin/env bun
// points pi's launcher at bun.
//
//   bun tools/bun-shebang.ts           patch, and report what changed
//   bun tools/bun-shebang.ts --check   report only, exit 1 when a patch is due
//
// run from postinstall, because `pi update` reinstalls the package and restores
// `#!/usr/bin/env node`. extensions/bun-runtime.ts runs the same repair at
// startup, for the sessions between one update and the next install.

import { findLauncher, describe, readLauncher, repairLaunchers } from '../extensions/lib/bun-launcher';

const check = process.argv.includes('--check');
const launcher = findLauncher();

if (launcher === null) {
    console.log('  warning  pi is not on PATH, so its launcher cannot be patched');
    process.exit(0);
}

if (check) {
    const found = readLauncher(launcher);
    if ('detail' in found) {
        console.log(`  ERROR    ${launcher} could not be read: ${found.detail}`);
        process.exit(1);
    }
    console.log(`  ${found.interpreter === 'bun' ? 'ok      ' : 'ERROR   '} ${launcher} runs under ${found.interpreter}`);
    process.exit(found.interpreter === 'bun' ? 0 : 1);
}

let failed = false;
for (const repair of repairLaunchers(launcher)) {
    const label = repair.kind === 'patched' || repair.kind === 'already-bun' ? 'ok     ' : 'warning';
    if (label === 'warning') failed = true;
    console.log(`  ${label}  ${describe(repair)}`);
}
process.exit(failed ? 1 : 0);
