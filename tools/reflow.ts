#!/usr/bin/env bun
// cli over extensions/lib/reflow.ts: rewrites markdown prose to one sentence
// per line (o5 in system/orthography.md).
import { reflow } from '../extensions/lib/reflow';

export { reflow, splitSentences } from '../extensions/lib/reflow';

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const paths = args.filter((arg) => !arg.startsWith('--'));
    if (paths.length === 0) {
        console.error('usage: bun tools/reflow.ts [--write] <file.md>...');
        process.exit(2);
    }
    for (const path of paths) {
        const source = await Bun.file(path).text();
        const result = reflow(source);
        const twice = reflow(result);
        if (twice !== result) {
            console.error(`${path}: not idempotent, refusing`);
            process.exit(1);
        }
        if (result === source) {
            console.log(`${path}: unchanged`);
            continue;
        }
        if (write) {
            await Bun.write(path, result);
            console.log(`${path}: rewritten`);
        } else {
            console.log(`${path}: would change`);
        }
    }
};

if (import.meta.main) await main();
