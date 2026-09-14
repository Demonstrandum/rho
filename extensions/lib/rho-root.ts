/**
 * rho's own directory, found rather than counted.
 *
 * Counting directories up from a source file breaks the moment the file is
 * somewhere else: the remote agent package has the extensions built into one
 * level, so `../..` from a bundled file lands outside it and a skill is read
 * from /tmp. Walking up to the directory that holds rho's resources works in
 * both shapes and in neither case guesses.
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/** what makes a directory rho's: the things its code reads at runtime. */
const MARKERS = ['skills', 'prompts', 'system'];

export function rhoRoot(from: string): string {
    let here = dirname(from);
    const stop = parse(here).root;
    for (;;) {
        if (MARKERS.some((marker) => existsSync(join(here, marker)))) return here;
        const up = dirname(here);
        if (up === here || here === stop) return dirname(from);
        here = up;
    }
}
