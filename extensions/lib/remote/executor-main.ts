#!/usr/bin/env bun
/**
 * The executable that runs on the far side.
 *
 * `bun build --compile` turns this into one static binary, which is what makes
 * a two-hour GPU node usable: no runtime to install, no package manager, no
 * root, nothing to clean up. Copy it, run it, and it dies with the connection.
 */

import { serve } from './executor';

const executor = serve(process.stdin, process.stdout);

// A machine that takes the connection down whenever anything goes wrong is
// worse than no machine: the session loses the environment, the working
// directory and every process it was holding. Nothing gets to kill this but a
// signal or the connection closing.
process.on('uncaughtException', (error) => {
    process.stderr.write(`executor: uncaught: ${(error as Error).message}\n`);
});
process.on('unhandledRejection', (reason) => {
    process.stderr.write(`executor: unhandled: ${String(reason)}\n`);
});

// A node being taken away is the expected ending, not an error. Kill the
// children rather than leaving them to be reaped by nothing.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
        executor.shutdown();
        process.exit(0);
    });
}
