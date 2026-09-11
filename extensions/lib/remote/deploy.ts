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
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectOverProcess } from './client';
import type { Connection } from './client';
import { parseAddress, sshTarget } from './address';
import type { Address } from './address';

/** Where the compiled executor is kept on this machine, and on the far side. */
const CACHE = join(process.env.HOME ?? '/tmp', '.cache', 'rho', 'remote');
const REMOTE_DIR = '.cache/rho/remote';

/**
 * Where this file's siblings are on disk.
 *
 * `import.meta.dir` is only a directory when the module was loaded from one.
 * pi can load an extension from a bundle, and then it is a data URL holding
 * the whole encoded source, so joining a filename onto it produces a "path"
 * of tens of thousands of characters and every read fails with ENAMETOOLONG
 * -- an error that names neither the file nor the cause.
 *
 * So it is resolved, checked, and falls back to the installed package.
 */
const sourceDir = (): string => {
    const candidates: string[] = [];
    const fromEnv = process.env.RHO_REMOTE_DIR;
    if (fromEnv !== undefined && fromEnv !== '') candidates.push(fromEnv);
    try {
        const url = import.meta.url;
        if (url.startsWith('file:')) candidates.push(dirname(fileURLToPath(url)));
    } catch {
        // not a file URL
    }
    const dir = import.meta.dir;
    if (typeof dir === 'string' && dir.length < 4096 && dir.startsWith('/')) candidates.push(dir);
    const home = process.env.HOME;
    if (home !== undefined) candidates.push(join(home, 'Code', 'rho', 'extensions', 'lib', 'remote'));

    for (const candidate of candidates) {
        if (existsSync(join(candidate, 'executor-main.ts'))) return candidate;
    }
    throw new Error(
        `cannot find the executor source. Looked in: ${candidates.map((c) => c.slice(0, 80)).join(', ')}. ` +
            'Set RHO_REMOTE_DIR to the directory holding executor-main.ts.',
    );
};

const ENTRY = (): string => join(sourceDir(), 'executor-main.ts');

/**
 * Kept as an alias so callers read as before, but it is the parsed record now:
 * the old version took the text apart with indexOf(':') and called the left
 * half a host, so `samuel@box:/srv` and `samuel@box` produced different shapes
 * of the same thing.
 */
export type Target = Address;

export function parseTarget(text: string): Address {
    const address = parseAddress(text);
    if (address === null) throw new Error(`not a machine address: ${text}`);
    return address;
}

/**
 * ssh with a shared connection.
 *
 * A fresh ssh to this fleet costs between one and three seconds of handshake,
 * paid on the probe, the copy and the attach; reusing a control socket costs
 * about a third of a second. ControlPersist keeps the master alive between
 * calls, so reconnecting a session is one cheap round trip rather than a new
 * handshake.
 */
const sshOptions = (role: 'command' | 'attach' = 'command'): string[] => {
    mkdirSync(CACHE, { recursive: true });
    const path = join(CACHE, 'cm-%C');
    // `no` for the attach, `auto` for everything else.
    //
    // A session that becomes the master keeps the shared connection alive, and
    // with it the pipe: when the far side's command exits, the client never
    // sees stdout close and waits out its whole timeout instead of failing in
    // milliseconds. That turned a cold connect into seventeen seconds, almost
    // all of it waiting for a process that had already gone.
    return role === 'attach'
        ? ['-o', 'ControlMaster=no', '-o', `ControlPath=${path}`]
        : ['-o', 'ControlMaster=auto', '-o', `ControlPath=${path}`, '-o', 'ControlPersist=10m'];
};

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
    const here = sourceDir();
    const source = readFileSync(join(here, 'executor-main.ts'));
    const shared = [readFileSync(join(here, 'executor.ts')), readFileSync(join(here, 'protocol.ts'))];
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
        ENTRY(),
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
    const here = sourceDir();
    const hash = createHash('sha256')
        .update(readFileSync(join(here, 'executor-main.ts')))
        .update(readFileSync(join(here, 'executor.ts')))
        .update(readFileSync(join(here, 'protocol.ts')))
        .digest('hex')
        .slice(0, 16);

    mkdirSync(CACHE, { recursive: true });
    const out = join(CACHE, `executor-${hash}.js`);
    try {
        if (statSync(out).size > 0) return { path: out, hash };
    } catch {
        // not bundled yet
    }
    const built = await run('bun', ['build', ENTRY(), '--target=node', '--outfile', out]);
    if (built.code !== 0) throw new Error(`could not bundle the executor: ${built.err || built.out}`);
    return { path: out, hash };
}

export async function deploy(
    target: Address,
    options: {
        readonly platform?: Platform;
        readonly onProgress?: (note: string) => void;
        /**
         * How long the executor keeps the session's state after the last
         * client leaves. Long enough to survive a break, short enough not to
         * hold a rented node overnight.
         */
        readonly idleMs?: number;
    } = {},
): Promise<Connection> {
    const say = options.onProgress ?? (() => {});
    // One formatting of the address, used everywhere ssh is called.
    const ssh_to = sshTarget(target);
    const platform = options.platform;
    const idle = options.idleMs ?? 3 * 60 * 60 * 1000;

    /**
     * The warm path: one ssh call, no questions asked.
     *
     * Probing for a runtime and checking for the bundle costs two round trips
     * before the one that matters, and the answers cannot have changed since
     * the executor was installed. So this asks the far side to attach if it
     * can, and to say so plainly if the bundle is not there; only then does
     * the slow path run.
     */
    const { hash: warmHash } = await bundle();
    const warmFile = `${REMOTE_DIR}/executor-${warmHash}.js`;
    const warmSocket = `${REMOTE_DIR}/exec-${warmHash}.sock`;
    const warmScript = [
        `R=$(command -v bun || command -v node || true)`,
        `[ -n "$R" ] || exit 42`,
        `[ -s ${warmFile} ] || exit 42`,
        `exec "$R" ${warmFile} --attach ${warmSocket} --idle ${idle}`,
    ].join('; ');

    const warm = connectOverProcess(ssh_to, 'ssh', [...sshOptions('attach'), ssh_to, warmScript]);
    // Bounded, because this is the handshake: a far side that is unreachable,
    // busy or wedged answers nothing, and waiting on it forever is worse than
    // falling through to the slow path that reports why.
    const hello = await warm.request({ kind: 'ping' }, undefined, 8_000);
    if (hello.kind === 'pong') {
        if (target.path !== null) {
            const moved = await warm.request({ kind: 'chdir', path: target.path });
            if (moved.kind === 'error') {
                warm.close();
                throw new Error(`no such directory on ${ssh_to}: ${target.path}`);
            }
        }
        return warm;
    }
    warm.close();

    // What the far side can run, asked rather than assumed. A compiled binary
    // is 82 MB and needs a loader the machine may not have: NixOS refuses a
    // generic glibc build outright, and has no musl loader either. A runtime
    // that is already there takes a 200 KB bundle instead, so the binary is
    // the fallback for a machine with nothing rather than the default.
    say(`checking ${ssh_to}`);
    const probe = await run('ssh', [
        ...sshOptions(),
        ssh_to,
        'command -v bun || command -v node || true; echo ---; uname -m',
    ]);
    if (probe.code !== 0) throw new Error(`cannot reach ${ssh_to}: ${probe.err.trim() || 'ssh failed'}`);
    const [runtimeLine = '', machineLine = ''] = probe.out.split('---');
    const runtime = runtimeLine.trim().split('\n')[0]?.trim() ?? '';
    const arm = machineLine.trim().startsWith('aarch64') || machineLine.trim().startsWith('arm64');

    let path: string;
    let hash: string;
    let start: string;
    if (runtime !== '') {
        say(`using ${runtime.split('/').pop()} on ${ssh_to}`);
        ({ path, hash } = await bundle());
        start = `${runtime} ${REMOTE_DIR}/executor-${hash}.js`;
    } else {
        say('compiling the executor, since the far side has no runtime');
        ({ path, hash } = await build(platform ?? (arm ? 'linux-arm64' : 'linux-x64')));
        start = `./${REMOTE_DIR}/executor-${hash}`;
    }
    const remote = runtime === '' ? `${REMOTE_DIR}/executor-${hash}` : `${REMOTE_DIR}/executor-${hash}.js`;

    const present = await run('ssh', [...sshOptions(), ssh_to, `test -s ${remote} && echo yes || echo no`]);
    if (present.out.trim() !== 'yes') {
        const bytes = readFileSync(path);
        say(`copying ${(bytes.byteLength / 1e6).toFixed(1)} MB to ${ssh_to}`);
        // Written to a temporary name and moved, so a connection that drops
        // half way does not leave a truncated file that passes the test above.
        const sent = await run(
            'ssh',
            [
                ...sshOptions(),
                ssh_to,
                `mkdir -p ${REMOTE_DIR} && cat > ${remote}.part && chmod +x ${remote}.part && mv ${remote}.part ${remote}`,
            ],
            bytes,
        );
        if (sent.code !== 0) throw new Error(`could not copy the executor: ${sent.err.trim()}`);
    }

    // Attached rather than started: the executor holds the working directory,
    // the environment and the process table behind a socket, and outlives the
    // ssh channel. A reconnect is then one round trip instead of a copy and a
    // cold start, which was taking fourteen seconds.
    const socket = `${REMOTE_DIR}/exec-${hash}.sock`;
    say(`attaching to the executor on ${ssh_to}`);
    const connection = connectOverProcess(ssh_to, 'ssh', [
        ...sshOptions('attach'),
        ssh_to,
        `${start} --attach ${socket} --idle ${idle}`,
    ]);

    const answered = await connection.request({ kind: 'ping' }, undefined, 15_000);
    if (answered.kind !== 'pong') {
        connection.close();
        throw new Error(`the executor did not answer on ${ssh_to}: ${JSON.stringify(answered)}`);
    }
    if (target.path !== null) {
        const moved = await connection.request({ kind: 'chdir', path: target.path });
        if (moved.kind === 'error') {
            connection.close();
            throw new Error(`no such directory on ${ssh_to}: ${target.path}`);
        }
    }
    return connection;
}
