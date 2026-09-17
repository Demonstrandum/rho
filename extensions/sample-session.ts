// `pi --sample-session`, and `/sample-session`: open a made-up session with
// every entry kind in it and two branch points.
//
// the transcript, the tree view, the pickers and the exporters are all hard to
// work on without a session to point them at, and the sessions that exist are
// somebody's work: their paths, their keys, their mistakes. this writes one
// from nothing, so it can go in a screenshot, be replayed on another machine,
// and be edited without losing anything.
//
// two decisions here were learned the hard way.
//
// the flag starts pi again rather than switching the session under it.
// a switch tears the extension runtime down and binds a new one, which fires
// session_start again with the flag still set: the first version wrote a
// sample and switched to it on every one of those, a loop that left thousands
// of session files in minutes. the switch also makes every extension holding a
// captured ctx report it as stale, since a replacement at startup is one
// nobody asked for. re-running pi with --session has neither problem: the
// session is the sample from the first line of the new process.
//
// the sample is one file at a fixed path, outside pi's session directory.
// a file per run fills /resume with copies of the same made-up session, and a
// sample is not work to come back to. it lives in rho's data directory and is
// rewritten on each use, so it is always the sample this version of rho
// defines, and /resume never lists it.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import envPaths from 'env-paths';
import { CURRENT_SESSION_VERSION, type ExtensionAPI, type SessionHeader } from '@earendil-works/pi-coding-agent';
import { sampleEntries } from './lib/sample-session';
import { sessionLines } from './lib/session-file';

const COMMAND = 'sample-session';
const FLAG = `--${COMMAND}`;
/** set on the re-run, so a pi that still sees the flag stops rather than loops. */
const MARKER = 'RHO_SAMPLE_SESSION';

/** the fixed id, so the sample is one session however often it is written. */
const SAMPLE_ID = '00000000-0000-4000-8000-000000000000';

function samplePath(): string {
    const dir = join(envPaths('rho', { suffix: '' }).data, 'sample');
    mkdirSync(dir, { recursive: true });
    return join(dir, 'sample-session.jsonl');
}

/** write the sample at its fixed path, replacing whatever was there. */
function writeSample(cwd: string): string {
    const path = samplePath();
    const header: SessionHeader = {
        type: 'session',
        version: CURRENT_SESSION_VERSION,
        id: SAMPLE_ID,
        timestamp: new Date().toISOString(),
        cwd,
    };
    writeFileSync(path, sessionLines(header, sampleEntries()), 'utf8');
    return path;
}

/** the command line to re-run with: the flag taken out, --session put in. */
export function sampleArgv(args: readonly string[], path: string): string[] {
    const rest = args.filter((arg) => arg !== FLAG && !arg.startsWith(`${FLAG}=`));
    return [...rest, '--session', path];
}

export default function (pi: ExtensionAPI) {
    pi.registerFlag(COMMAND, {
        description: 'open a made-up session with tool calls, thinking, and branches in it',
        type: 'boolean',
        default: false,
    });

    pi.registerCommand(COMMAND, {
        description: 'Open a made-up session with tool calls, thinking, and branches in it',
        handler: async (_args, ctx) => {
            await ctx.switchSession(writeSample(ctx.cwd));
        },
    });

    // the factory runs while pi is still starting up, before the TUI owns the
    // terminal, which is what makes replacing this process safe here, as it is
    // in bun-runtime.ts. the flag is read off argv rather than through
    // pi.getFlag because flag values are not resolved yet at factory time.
    const args = process.argv.slice(2);
    const asked = args.some((arg) => arg === FLAG || arg.startsWith(`${FLAG}=`));
    if (!asked || process.env[MARKER] === '1') return;

    const child = spawnSync(process.execPath, [process.argv[1]!, ...sampleArgv(args, writeSample(process.cwd()))], {
        stdio: 'inherit',
        env: { ...process.env, [MARKER]: '1' },
    });
    if (child.error !== undefined) {
        process.stderr.write(`\nrho: could not start pi on the sample session: ${child.error.message}\n`);
        process.exit(1);
    }
    process.exit(child.status ?? 0);
}
