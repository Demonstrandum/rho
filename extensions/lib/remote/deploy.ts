/**
 * Getting the executor onto a machine that has nothing.
 *
 * A rented GPU node exists for two hours. It has no Nix, no package manager
 * worth using, often no bun, and no root. `bun build --compile` answers all of
 * that: one static executable, copied over the ssh connection that is already
 * open, cached on the far side by content hash so reconnecting to the same
 * node costs a `test -x` and nothing else.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connectOverProcess } from './client';
import type { Connection } from './client';

/** Where the compiled executor is kept on this machine, and on the far side. */
const CACHE = join(process.env.HOME ?? '/tmp', '.cache', 'rho', 'remote');
const REMOTE_DIR = '.cache/rho/remote';

const ENTRY = join(import.meta.dir, 'executor-main.ts');

export interface Target {
    /** user@host, as ssh understands it. */
    readonly host: string;
    /** Where to start. Absent means the login directory. */
    readonly path?: string;
}

/** `user@host:/path`, the form that also addresses a single file. */
export function parseTarget(text: string): Target {
    const at = text.indexOf(':');
    if (at === -1) return { host: text };
    return { host: text.slice(0, at), path: text.slice(at + 1) };
}

const run = (
    command: string,
    args: readonly string[],
    input?: Uint8Array,
): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((settle) => {
        const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            err += chunk.toString();
        });
        child.on('error', (error) => settle({ code: null, out, err: error.message }));
        child.on('close', (code) => settle({ code, out, err }));
        if (input !== undefined) child.stdin.write(input);
        child.stdin.end();
    });

/**
 * Compile the executor for a target platform, once per content.
 *
 * The hash is of the source, not the binary, because two compilations of the
 * same source are not byte-identical and a hash that changes every time
 * defeats the cache it exists to key.
 */
export type Platform = 'linux-x64-musl' | 'linux-arm64-musl' | 'linux-x64' | 'linux-arm64' | 'darwin-arm64';

/**
 * musl by default, because the glibc build is dynamically linked and NixOS
 * refuses to run those: "cannot run dynamically linked executables intended
 * for generic linux environments". A statically linked binary has no such
 * opinion, and a fleet with one NixOS box in it is the normal case here.
 */
export async function build(platform: Platform): Promise<{
    path: string;
    hash: string;
}> {
    const source = readFileSync(ENTRY);
    const shared = [
        readFileSync(join(import.meta.dir, 'executor.ts')),
        readFileSync(join(import.meta.dir, 'protocol.ts')),
    ];
    const hash = createHash('sha256')
        .update(source)
        .update(shared[0] ?? '')
        .update(shared[1] ?? '')
        .update(platform)
        .digest('hex')
        .slice(0, 16);

    mkdirSync(CACHE, { recursive: true });
    const out = join(CACHE, `executor-${platform}-${hash}`);

    try {
        if (statSync(out).size > 0) return { path: out, hash };
    } catch {
        // not built yet
    }

    const built = await run('bun', [
        'build',
        ENTRY,
        '--compile',
        `--target=bun-${platform}`,
        '--outfile',
        out,
    ]);
    if (built.code !== 0) throw new Error(`could not compile the executor: ${built.err || built.out}`);
    return { path: out, hash };
}

/**
 * Put the executor on the target if it is not already there, and open a
 * connection through it.
 *
 * `cat > file` over ssh rather than scp, because scp is a second connection
 * and a second authentication, and because some of these nodes have a
 * restricted shell but always have a pipe.
 */
/**
 * The executor as one JavaScript file, for a machine that already has bun or
 * node. 200 KB instead of 82 MB, and no loader to be refused by.
 */
export async function bundle(): Promise<{ path: string; hash: string }> {
    const hash = createHash('sha256')
        .update(readFileSync(ENTRY))
        .update(readFileSync(join(import.meta.dir, 'executor.ts')))
        .update(readFileSync(join(import.meta.dir, 'protocol.ts')))
        .digest('hex')
        .slice(0, 16);

    mkdirSync(CACHE, { recursive: true });
    const out = join(CACHE, `executor-${hash}.js`);
    try {
        if (statSync(out).size > 0) return { path: out, hash };
    } catch {
        // not bundled yet
    }
    const built = await run('bun', ['build', ENTRY, '--target=node', '--outfile', out]);
    if (built.code !== 0) throw new Error(`could not bundle the executor: ${built.err || built.out}`);
    return { path: out, hash };
}

export async function deploy(
    target: Target,
    options: { readonly platform?: Platform; readonly onProgress?: (note: string) => void } = {},
): Promise<Connection> {
    const say = options.onProgress ?? (() => {});
    const platform = options.platform;

    // What the far side can run, asked rather than assumed. A compiled binary
    // is 82 MB and needs a loader the machine may not have: NixOS refuses a
    // generic glibc build outright, and has no musl loader either. A runtime
    // that is already there takes a 200 KB bundle instead, so the binary is
    // the fallback for a machine with nothing rather than the default.
    say(`checking ${target.host}`);
    const probe = await run('ssh', [
        target.host,
        'command -v bun || command -v node || true; echo ---; uname -m',
    ]);
    if (probe.code !== 0) throw new Error(`cannot reach ${target.host}: ${probe.err.trim() || 'ssh failed'}`);
    const [runtimeLine = '', machineLine = ''] = probe.out.split('---');
    const runtime = runtimeLine.trim().split('\n')[0]?.trim() ?? '';
    const arm = machineLine.trim().startsWith('aarch64') || machineLine.trim().startsWith('arm64');

    let path: string;
    let hash: string;
    let start: string;
    if (runtime !== '') {
        say(`using ${runtime.split('/').pop()} on ${target.host}`);
        ({ path, hash } = await bundle());
        start = `${runtime} ${REMOTE_DIR}/executor-${hash}.js`;
    } else {
        say('compiling the executor, since the far side has no runtime');
        ({ path, hash } = await build(platform ?? (arm ? 'linux-arm64' : 'linux-x64')));
        start = `./${REMOTE_DIR}/executor-${hash}`;
    }
    const remote = runtime === '' ? `${REMOTE_DIR}/executor-${hash}` : `${REMOTE_DIR}/executor-${hash}.js`;

    const present = await run('ssh', [target.host, `test -s ${remote} && echo yes || echo no`]);
    if (present.out.trim() !== 'yes') {
        const bytes = readFileSync(path);
        say(`copying ${(bytes.byteLength / 1e6).toFixed(1)} MB to ${target.host}`);
        // Written to a temporary name and moved, so a connection that drops
        // half way does not leave a truncated file that passes the test above.
        const sent = await run(
            'ssh',
            [
                target.host,
                `mkdir -p ${REMOTE_DIR} && cat > ${remote}.part && chmod +x ${remote}.part && mv ${remote}.part ${remote}`,
            ],
            bytes,
        );
        if (sent.code !== 0) throw new Error(`could not copy the executor: ${sent.err.trim()}`);
    }

    say(`starting the executor on ${target.host}`);
    const connection = connectOverProcess(target.host, 'ssh', [target.host, start]);

    const hello = await connection.request({ kind: 'ping' });
    if (hello.kind !== 'pong') {
        connection.close();
        throw new Error(`the executor did not answer on ${target.host}: ${JSON.stringify(hello)}`);
    }
    if (target.path !== undefined) {
        const moved = await connection.request({ kind: 'chdir', path: target.path });
        if (moved.kind === 'error') {
            connection.close();
            throw new Error(`no such directory on ${target.host}: ${target.path}`);
        }
    }
    return connection;
}
