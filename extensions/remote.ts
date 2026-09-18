/**
 * /remote — the session runs on the always-on host, the laptop only looks at it.
 *
 *   /remote create work samuel@dev-box        start a named session there
 *   /remote create work samuel@dev-box:/srv   ... in a directory
 *   /remote connect work                          attach this pi to it
 *   /remote list                                  what is running there
 *   /remote stop work
 *
 * `create` does the ssh part, so the person never types ssh: it ships the
 * session runner to the host the same way the executor is shipped, starts a
 * detached broker, and returns as soon as the session is up. `connect` then
 * hands this terminal over to it.
 *
 * The laptop holds nothing. Close it, open it tomorrow, connect again, and the
 * session is where it was, because the agent was never running here.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { addressName, parseAddress, sshTarget } from './lib/remote/address';
import { browse } from './lib/picker';
import { controlPath } from './lib/remote/agent-tag';
import { shorthandFor, takeVerb } from './lib/shorthand';
import { completeLastWord, lastWord } from './lib/complete-words';
import { troubleWith } from './lib/remote/advice';
import { agentTrouble, describeAgentTrouble } from './lib/remote/ssh-agent';
import { branchSlug, parseProjectRequest, projectNameOf, repoName, sessionName } from './lib/remote/naming';
import type { ProjectRequest } from './lib/remote/naming';
import { publishConnect, readLedger, writeLedger } from './lib/remote/sessions';
import type { Worktree } from './lib/remote/sessions';
import { projectPlan } from './lib/remote/project';
import { entryCount, freePath, rehomed, sessionIdOf } from './lib/remote/transfer';
import { askInterfaceToLeave } from './lib/remote/leave';
import { carryEnv, leavingIn, withoutLeaving } from './lib/remote/leaving';
import { leaveTerminal, resumeLines } from './lib/leave-terminal';
import { modelFlags } from './lib/remote/pi-args';
import type { ModelChoice } from './lib/remote/pi-args';
import { config } from './lib/config';

/** What /remote can be asked to do. A word is matched against these. */
const VERBS = ['create', 'connect', 'project', 'list', 'manage', 'stop'] as const;

const CACHE = join(process.env.HOME ?? '/tmp', '.cache', 'rho', 'remote');
const REMOTE_DIR = '.cache/rho/remote';
// Same reason as deploy.ts: import.meta.dir is a data URL when pi loads this
// from a bundle, and every read then fails with ENAMETOOLONG.
/** rho's own directory, for the client that lives beside this file. */
const rhoRoot = (): string => join(remoteDir(), '..', '..', '..');

const remoteDir = (): string => {
    const candidates: string[] = [];
    const fromEnv = process.env.RHO_REMOTE_DIR;
    if (fromEnv !== undefined && fromEnv !== '') candidates.push(fromEnv);
    try {
        const url = import.meta.url;
        if (url.startsWith('file:')) candidates.push(join(dirname(fileURLToPath(url)), 'lib', 'remote'));
    } catch {
        // not a file URL
    }
    const dir = import.meta.dir;
    if (typeof dir === 'string' && dir.length < 4096 && dir.startsWith('/')) {
        candidates.push(join(dir, 'lib', 'remote'));
    }
    const home = process.env.HOME;
    if (home !== undefined) candidates.push(join(home, 'Code', 'rho', 'extensions', 'lib', 'remote'));

    for (const candidate of candidates) {
        if (existsSync(join(candidate, 'session-main.ts'))) return candidate;
    }
    throw new Error('cannot find session-main.ts; set RHO_REMOTE_DIR to the directory holding it');
};

/**
 * The same flags the executor's connections use.
 *
 * Without ConnectTimeout an unreachable host blocks the command handler, and
 * pi has no input while a handler runs: the person sees the field clear and
 * nothing else. Without ClearAllForwardings a port forward in the person's ssh
 * config prints its complaint into the output being parsed.
 */
const SSH_FLAGS = [
    // A node allocated a minute ago has a host key nothing has seen before,
    // and a command run by a tool has no terminal to answer a prompt on: the
    // prompt appeared in the person's session instead, under whatever they
    // were reading at the time. accept-new trusts an unknown host once and
    // still refuses one whose key has changed, which is the case that matters.
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'BatchMode=yes',
    // A handshake to this fleet costs seconds, so it is paid once and shared:
    // the second call down the same connection is a tenth of the first.
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath(CACHE)}`,
    '-o',
    'ControlPersist=10m',
];

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
 * The session runner as one executable, for a machine with no runtime at all.
 *
 * Cached by a hash of the source rather than of the binary: two compilations
 * of the same source are not byte-identical, and a key that changes every time
 * is not a cache.
 */
async function compile(platform: 'linux-x64' | 'linux-arm64'): Promise<{ path: string; hash: string }> {
    const here = remoteDir();
    const hash = createHash('sha256')
        .update(readFileSync(join(here, 'session-main.ts')))
        .update(readFileSync(join(here, 'broker.ts')))
        .update(readFileSync(join(here, 'protocol.ts')))
        .update(platform)
        .digest('hex')
        .slice(0, 16);
    mkdirSync(CACHE, { recursive: true });
    const out = join(CACHE, `session-${platform}-${hash}`);
    try {
        if (statSync(out).size > 0) return { path: out, hash };
    } catch {
        // not compiled yet
    }
    const built = await run('bun', [
        'build',
        join(here, 'session-main.ts'),
        '--compile',
        `--target=bun-${platform}`,
        '--outfile',
        out,
    ]);
    if (built.code !== 0) throw new Error(`could not compile the session runner: ${built.err || built.out}`);
    return { path: out, hash };
}

/** The session runner as one file, cached by a hash of its source. */
export async function bundle(): Promise<{ path: string; hash: string }> {
    const here = remoteDir();
    const hash = createHash('sha256')
        .update(readFileSync(join(here, 'session-main.ts')))
        .update(readFileSync(join(here, 'broker.ts')))
        .update(readFileSync(join(here, 'protocol.ts')))
        .digest('hex')
        .slice(0, 16);
    mkdirSync(CACHE, { recursive: true });
    const out = join(CACHE, `session-${hash}.js`);
    try {
        if (statSync(out).size > 0) return { path: out, hash };
    } catch {
        // not bundled yet
    }
    const built = await run('bun', ['build', join(remoteDir(), 'session-main.ts'), '--target=node', '--outfile', out]);
    if (built.code !== 0) throw new Error(`could not bundle the session runner: ${built.err || built.out}`);
    return { path: out, hash };
}

/**
 * Put the runner on the host if it is not there, and say how to start it.
 *
 * No setup on the far side, on any account: a machine with bun or node takes a
 * small bundle, and a machine with neither takes a compiled executable, the
 * same fallback the executor uses. Refusing a bare host was asking the person
 * to install a runtime first, which is the thing this is supposed to avoid.
 */
/**
 * The name the client uses to reach the runner.
 *
 * create() installs it by content hash, so two versions never collide; the
 * client needs one name it can count on, so the installed file is also linked
 * here. A link rather than a copy: the same bytes, one place to look.
 */
export const RUNNER_LINK = `${REMOTE_DIR}/session-runner.js`;

/**
 * Build the session runner on this machine and link it where /detach looks.
 *
 * /detach needs no host and no ssh, so it has never gone through create() or
 * ensureRunner(): both write the link by shelling out to a machine this
 * process already is. This is that link, made locally, so a first /detach
 * builds the runner instead of naming the command that would.
 */
export async function buildRunnerLocally(): Promise<string> {
    const { hash } = await bundle();
    const link = join(CACHE, 'session-runner.js');
    try {
        symlinkSync(`session-${hash}.js`, link);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        unlinkSync(link);
        symlinkSync(`session-${hash}.js`, link);
    }
    return link;
}

async function place(host: string, say: (note: string) => void): Promise<string> {
    const probe = await run('ssh', [...SSH_FLAGS, host, 'command -v bun || command -v node || true; echo ---; uname -m']);
    if (probe.code !== 0) throw new Error(`cannot reach ${host}: ${probe.err.trim() || 'ssh failed'}`);
    const [runtimeLine = '', machineLine = ''] = probe.out.split('---');
    const runtime = runtimeLine.trim().split('\n')[0]?.trim();
    const arm = machineLine.trim().startsWith('aarch64') || machineLine.trim().startsWith('arm64');

    if (runtime === undefined || runtime === '') {
        say(`compiling the session runner for ${host}, which has no runtime`);
        const { path, hash } = await compile(arm ? 'linux-arm64' : 'linux-x64');
        const remote = `${REMOTE_DIR}/session-${hash}`;
        const present = await run('ssh', [...SSH_FLAGS, host, `test -x ${remote} && echo yes || echo no`]);
        if (present.out.trim() !== 'yes') {
            say(`copying the session runner to ${host}`);
            const sent = await run(
                'ssh',
                [host, `mkdir -p ${REMOTE_DIR} && cat > ${remote}.part && chmod +x ${remote}.part && mv ${remote}.part ${remote}`],
                readFileSync(path),
            );
            if (sent.code !== 0) throw new Error(`could not copy the session runner: ${sent.err.trim()}`);
        }
        return `./${remote}`;
    }

    const { path, hash } = await bundle();
    const remote = `${REMOTE_DIR}/session-${hash}.js`;
    const present = await run('ssh', [...SSH_FLAGS, host, `test -s ${remote} && echo yes || echo no`]);
    if (present.out.trim() !== 'yes') {
        say(`copying the session runner to ${host}`);
        const sent = await run(
            'ssh',
            [host, `mkdir -p ${REMOTE_DIR} && cat > ${remote}.part && mv ${remote}.part ${remote}`],
            readFileSync(path),
        );
        if (sent.code !== 0) throw new Error(`could not copy the session runner: ${sent.err.trim()}`);
    }
    return `${runtime} ${remote}`;
}

/** Where the agent's own pi is kept on a host, one directory per version. */
const PI_DIR = '.cache/rho/pi';
/** Where a bun new enough to run it is kept, when the host's own is not. */
const BUN_DIR = '.cache/rho/bun';
/** Where rho itself is kept, one directory per revision of its source. */
const RHO_DIR = '.cache/rho/agent';

/**
 * The oldest bun that can run the pi this machine is running.
 *
 * dev-box's 1.3.13 dies inside undici on pi 0.85.1, with an error about
 * markAsUncloneable, and rho's extensions are typescript, which means bun
 * rather than node has to be the one that loads them.
 */
const MIN_BUN = [1, 4, 0] as const;

const newEnough = (version: string): boolean => {
    const parts = version.trim().split('.').map((piece) => Number.parseInt(piece, 10));
    for (const [index, least] of MIN_BUN.entries()) {
        const found = parts[index] ?? 0;
        if (found > least) return true;
        if (found < least) return false;
    }
    return true;
};

/** The version of pi this machine is running. */
function localPiVersion(): string | null {
    try {
        const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
        const manifest = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
            version?: string;
        };
        return manifest.version ?? null;
    } catch {
        // pi is not resolvable from here: the host's own is what there is.
        return null;
    }
}

/**
 * Where a project lives on the host. One clone, many worktrees, because that
 * is what a session per branch needs: a worktree is a directory sharing one
 * object store, so ten branches cost one clone rather than ten.
 *
 *   ~/projects/<project>/checkout/<repo>     the clone
 *   ~/projects/<project>/worktrees/<branch>  where a session works
 */
const PROJECTS = 'projects';

/**
 * A turning status line for work that takes a while.
 *
 * pi takes the input field away while a command handler runs, so a slow step
 * with nothing on screen is indistinguishable from a session that has hung.
 * Starting a session on a small machine is slow for a reason that is not ours:
 * pi's own startup there is twenty seconds, so the person is told what is
 * happening and how long it has been happening for.
 */
const FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

interface Progress {
    say(step: string): void;
    done(): void;
}

const progress = (ctx: { ui: { setStatus: (key: string, text?: string) => void } }): Progress => {
    const started = Date.now();
    let step = 'working';
    let frame = 0;
    const tick = setInterval(() => {
        frame = (frame + 1) % FRAMES.length;
        const seconds = Math.round((Date.now() - started) / 1000);
        ctx.ui.setStatus('rho-remote', `${FRAMES[frame]} ${step}\u2026 ${seconds}s`);
    }, 120);
    tick.unref?.();
    return {
        say(next: string) {
            step = next;
        },
        done() {
            clearInterval(tick);
            ctx.ui.setStatus('rho-remote', undefined);
        },
    };
};

export default function (pi: ExtensionAPI) {
    /** Where each named session lives, so connect and stop need only the name. */
    /**
     * Which machine each session is on, remembered across pi processes.
     *
     * A session outlives the pi that started it -- that is the point of it --
     * so the next pi has to be told where it is, or connecting to a session
     * created five minutes ago in another window fails with "I do not know
     * which host". It is a small file beside the runner cache rather than
     * session state, because it is a fact about the machine, not about a
     * conversation.
     */
    // The file itself is read and written by lib/remote/sessions.ts, which is
    // also where `pi --attach` asks whether a name is on another machine.
    const { hosts, worktrees } = readLedger();

    const rememberHosts = (): void => writeLedger({ hosts, worktrees });

    /**
     * The model this interface is using, given to a session it starts.
     *
     * A session on another machine is `pi --mode rpc` with no model named, so
     * pi picked its own default there: every remote session opened on the
     * provider's default model whatever this machine was set to, and the only
     * way back was /model on the far side. The session inherits the model of
     * the interface that created it, the way a local session inherits the
     * settings of the machine it starts on.
     */
    let modelHere: ModelChoice | null = null;
    const noteModel = (model: { provider?: string; id?: string } | undefined, thinking: string): void => {
        if (model?.provider === undefined || model.id === undefined) return;
        modelHere = { provider: model.provider, id: model.id, thinking };
    };
    pi.on('session_start', async (_event, ctx: ExtensionContext) => {
        noteModel(ctx.model, ctx.thinkingLevel ?? 'off');
    });
    pi.on('model_select', async (event, ctx: ExtensionContext) => {
        noteModel(event.model, ctx.thinkingLevel ?? 'off');
    });
    pi.on('thinking_level_select', async (event, ctx: ExtensionContext) => {
        noteModel(ctx.model, event.level ?? 'off');
    });

    /** The tail of the serve command that names the model, if there is one to name. */
    const modelArgs = (): string => {
        const flags = modelFlags(modelHere);
        return flags.length === 0 ? '' : ` -- ${flags.join(' ')}`;
    };

    /**
     * What this laptop is logged in with, and nothing else.
     *
     * auth.json is the whole of it: an OAuth login, and any key stored through
     * /login. Keys from this shell's environment used to travel too, which is
     * a second identity the session can pick over the first -- the far side
     * then bills an api account while the laptop bills the subscription, and
     * the two disagree about what the session costs. The session is this
     * login, somewhere else.
     */
    const lend = (): Uint8Array => {
        let auth: string | null = null;
        try {
            auth = readFileSync(join(process.env.HOME ?? '', '.pi', 'agent', 'auth.json'), 'utf8');
        } catch {
            // nothing stored here, and nothing else to send: a session with no
            // credentials says so on its first turn rather than guessing.
        }
        return new TextEncoder().encode(JSON.stringify({ auth }));
    };

    const project = async (host: string, asked: ProjectRequest, say: (note: string) => void): Promise<string> => {
        // The layout is one definition, shared with the checkout the agent
        // asks for on whatever machine it is attached to. See lib/remote/project.ts.
        const { script, worktree } = projectPlan({
            source: asked.source,
            branch: asked.branch,
            base: asked.base,
            name: asked.name,
        });
        const what = projectNameOf(asked.source);

        // Asked before the clone rather than discovered as GitHub's refusal:
        // -A with no agent forwards nothing, and the far side reports a
        // permission denied that sends people to look at their keys and the
        // host's authorized_keys, neither of which is the fault.
        const trouble = agentTrouble();
        if (trouble !== null) throw new Error(describeAgentTrouble(trouble, `${what} on ${host}`));

        say(`${asked.source.kind === 'repository' ? 'cloning' : 'branching'} ${what} on ${host}`);

        // -A forwards the agent for the clone. Without it a private repo needs
        // a key on the host, which is the thing this avoids.
        //
        // Not SSH_FLAGS: those clear every forwarding, which includes the
        // agent. The two options that matter here are kept by hand, and the
        // host key is accepted the same way as everywhere else rather than
        // asking a question nobody is there to answer.
        const done = await run('ssh', [
            '-o',
            'StrictHostKeyChecking=accept-new',
            '-o',
            'LogLevel=ERROR',
            '-A',
            host,
            script,
        ]);
        if (done.code !== 0) throw new Error(done.err.trim() || done.out.trim() || 'the clone failed');
        const path = done.out.trim().split('\n').pop() ?? worktree;
        return path;
    };

    const create = async (name: string, address: string, say: (note: string) => void): Promise<string> => {
        const address_ = parseAddress(address);
        if (address_ === null) throw new Error(`not a machine address: ${address}`);
        const host = sshTarget(address_);

        // One call, not four.
        //
        // Probing for a runtime, testing for the runner and starting it were
        // three round trips before the one that mattered, and a handshake to
        // this fleet is seconds rather than milliseconds. This asks the far
        // side to start the session if it already has what it needs, and to
        // say so plainly if it does not; only then is anything copied.
        const { hash } = await bundle();
        const file = `${REMOTE_DIR}/session-${hash}.js`;
        // The same agent on both machines: this pi, a bun new enough to run it,
        // and rho itself. Each is kept on the host and sent only when it is not
        // already the one that is wanted.
        const lentPi = await ensurePi(host, say).catch(() => null);
        const lentRho = await ensureRho(host, lentPi, say).catch(() => null);
        const withPi =
            (lentPi === null ? '' : `RHO_PI_CLI=${lentPi} `) + (lentRho === null ? '' : `RHO_RHO_DIR=${lentRho} `);
        const quick = [
            `R=$(command -v bun || command -v node || true)`,
            `[ -n "$R" ] || exit 42`,
            `[ -s ${file} ] || exit 43`,
            `${withPi}exec "$R" ${file} serve ${name} ${address_.path ?? '$HOME'}${modelArgs()}`,
        ].join('; ');
        /**
         * The name the client attaches by.
         *
         * The runner is installed by content hash so two versions never
         * collide, and the client needs one name that does not change. The
         * link is made beside whichever file was installed, in the same call
         * that starts the session, so it can never point at a file that is not
         * there.
         */
        const linkRunner = `ln -sf $(basename ${file}) ${RUNNER_LINK}`;

        const attempt = await run('ssh', [...SSH_FLAGS, host, quick], lend());
        // A session that is already up is the outcome asked for, not an error:
        // create is how you get one, and one exists.
        if (/already running/.test(attempt.out) || /already running/.test(attempt.err)) {
            hosts.set(name, host);
            rememberHosts();
            return `${name} is already running on ${host}`;
        }
        if (attempt.code === 0) {
            hosts.set(name, host);
            rememberHosts();
            await run('ssh', [...SSH_FLAGS, host, linkRunner]);
            return attempt.out.trim();
        }
        if (attempt.code !== 42 && attempt.code !== 43) {
            throw new Error(attempt.err.trim() || attempt.out.trim() || `could not start ${name}`);
        }

        const runner = await place(host, say);
        say(`starting ${name} on ${host}`);
        // The host owns no credentials of its own: what this laptop is logged
        // in with goes down the ssh channel into a config directory the
        // session holds for as long as it runs, and dies with it.
        const started = await run(
            'ssh',
            [...SSH_FLAGS, host, `${withPi}${runner} serve ${name} ${address_.path ?? '$HOME'}${modelArgs()}`],
            lend(),
        );
        await run('ssh', [...SSH_FLAGS, host, linkRunner]);
        if (started.code !== 0) {
            throw new Error(started.err.trim() || started.out.trim() || `could not start ${name}`);
        }
        hosts.set(name, host);
        rememberHosts();
        return started.out.trim();
    };

    /**
     * Run a runner command in one ssh call.
     *
     * Asking place() first meant probing for a runtime and checking for the
     * file before every list or stop: three round trips to this fleet is
     * seconds, and the answers cannot have changed since the runner was
     * installed. This uses the stable link, and installs only when the far
     * side says it is not there.
     */
    const ask = async (
        host: string,
        verb: string,
        say: (note: string) => void,
        input?: Uint8Array,
    ): Promise<string> => {
        const quick = [
            `R=$(command -v bun || command -v node || true)`,
            `[ -n "$R" ] || exit 42`,
            `[ -s ${RUNNER_LINK} ] || exit 43`,
            `exec "$R" ${RUNNER_LINK} ${verb}`,
        ].join('; ');
        const attempt = await run('ssh', [...SSH_FLAGS, host, quick], input);
        if (attempt.code === 0) return attempt.out.trim();
        if (attempt.code !== 42 && attempt.code !== 43) {
            throw new Error(attempt.err.trim() || attempt.out.trim() || `${verb} failed on ${host}`);
        }
        const runner = await place(host, say);
        const again = await run('ssh', [...SSH_FLAGS, host, `${runner} ${verb}`], input);
        return again.out.trim();
    };

    /** What a session on a host says about itself, for deciding what to carry. */
    interface Far {
        readonly cwd: string;
        readonly sessionId: string | null;
        readonly messages: number;
        readonly streaming: boolean;
    }

    const farSide = async (host: string, session: string): Promise<Far | null> => {
        const said = await ask(host, `state ${session}`, () => {}).catch(() => '');
        try {
            const parsed: unknown = JSON.parse(said.trim());
            if (typeof parsed !== 'object' || parsed === null) return null;
            const held = parsed as Partial<Far>;
            return {
                cwd: typeof held.cwd === 'string' ? held.cwd : '',
                sessionId: typeof held.sessionId === 'string' ? held.sessionId : null,
                messages: typeof held.messages === 'number' ? held.messages : 0,
                streaming: held.streaming === true,
            };
        } catch {
            // An older runner there has no `state` verb, so nothing is carried.
            return null;
        }
    };

    /**
     * Whether this conversation and that session's are the same one.
     *
     * A session file carries its identity through every copy, so two files with
     * one id are one conversation held on two machines. That is the whole test:
     * a session that shares this id is continued rather than handed anything,
     * and a session with a conversation of its own is left alone.
     */
    type Joined = 'joined' | 'sent' | 'apart';

    /**
     * Opening a carried conversation here, and speaking inside it.
     *
     * The second argument is not a convenience. Replacing the session
     * invalidates the context that asked for the replacement, so anything said
     * afterwards has to be said with the context of the session that arrived;
     * pi refuses the stale one by name and prints the refusal as an extension
     * error under the resumed transcript.
     */
    type Adopt = (path: string, then: (ctx: ExtensionCommandContext) => void) => Promise<void>;

    /**
     * Hand a fresh session on another machine this conversation.
     *
     * Only when it is fresh: an agent with a history of its own is somebody's
     * work, and pushing another conversation over it would bury it. Only when
     * it is idle, for the same reason attaching does not restart a session
     * mid-turn.
     */
    const carryUp = async (ctx: ExtensionContext, host: string, session: string): Promise<Joined> => {
        const file = ctx.sessionManager.getSessionFile();
        if (file === undefined || !existsSync(file)) return 'apart';
        const far = await farSide(host, session);
        if (far === null) return 'apart';

        const here = readFileSync(file, 'utf8');
        const mine = sessionIdOf(here);
        if (far.sessionId !== null && mine !== null && far.sessionId === mine) return 'joined';
        if (far.messages > 0 || far.streaming) return 'apart';
        if (entryCount(here) === 0) return 'apart';

        await ask(host, `adopt ${session}`, () => {}, new TextEncoder().encode(here));
        return 'sent';
    };

    /**
     * Bring back what was said over there, so this machine holds it too.
     *
     * The file that comes back is this conversation with more in it: same id,
     * the entries from before the connection and the entries from during it.
     * It is rehomed to this machine's directory, written beside this session's
     * own files, and opened here, which is what makes leaving the far side and
     * carrying on locally one continuous conversation rather than two.
     */
    const carryBack = async (
        ctx: ExtensionContext,
        host: string,
        session: string,
        adopt: Adopt,
    ): Promise<number | null> => {
        const carried = await ask(host, `carry ${session}`, () => {});
        if (carried.trim() === '') return null;
        const dir = ctx.sessionManager.getSessionDir();
        if (dir === '') return null;
        mkdirSync(dir, { recursive: true });
        const path = freePath(dir, `${sessionIdOf(carried) ?? session}.jsonl`);
        writeFileSync(path, rehomed(`${carried}\n`, ctx.cwd));
        const entries = entryCount(carried);
        // Everything this interface has to say about the conversation is said
        // by the interface the conversation arrives in. The ctx that opened it
        // is stale from the moment the session is replaced, and pi reports a
        // use of it as an extension error under the resumed transcript.
        await adopt(path, (fresh) =>
            fresh.ui.notify(
                `back from ${session} on ${host}, carrying ${entries} entries. it is still running there.`,
                'info',
            ),
        );
        return entries;
    };


    /**
     * The sessions this machine knows about, each with the host it is on.
     *
     * The ledger is what was started from here; the hosts in it are asked
     * whether those sessions are still running, so a list never offers one that
     * has been stopped from somewhere else.
     */
    const knownSessions = async (): Promise<{ name: string; host: string; state: 'running' | 'stopped' }[]> => {
        const machines = [...new Set([...hosts.values(), ...[...worktrees.values()].map((tree) => tree.host)])];
        const answers = await Promise.all(
            machines.map(async (host) => ({ host, sessions: await held(host).catch(() => []) })),
        );
        const found = answers.flatMap(({ host, sessions }) =>
            sessions.map((session) => ({ name: session.name, host, state: session.state })),
        );
        // Anything remembered here that the host did not mention: it was
        // forgotten over there, and offering it would be offering a ghost.
        return found.sort((a, b) => a.name.localeCompare(b.name));
    };

    /**
     * Which session, when the command did not say.
     *
     * A name is easier to pick from a list than to remember, and the list is
     * the only place that knows which of them are still running.
     */
    const chooseSession = async (ctx: ExtensionContext, verb: string): Promise<string | null> => {
        const sessions = await knownSessions();
        return browse(ctx, {
            title: `remote sessions to ${verb}`,
            empty: 'no remote sessions. /remote create <name> <user@host> starts one',
            items: () =>
                sessions.map((session) => ({
                    value: session.name,
                    label: session.name,
                    description: [
                        session.host,
                        session.state,
                        worktrees.has(session.name) ? 'project' : '',
                    ]
                        .filter((part) => part !== '')
                        .join(', '),
                })),
            action: () => ({ choose: verb }),
        });
    };

    /** One running session on one host, as the runner reports it. */
    interface Running {
        readonly name: string;
        readonly cwd: string;
    }

    const parseListing = (listed: string): Running[] =>
        listed
            .split('\n')
            .map((line) => line.split('\t'))
            .filter((columns) => columns.length >= 2 && columns[1]?.trim() === 'running')
            .map((columns) => ({ name: columns[0]?.trim() ?? '', cwd: columns[2]?.trim() ?? '' }))
            .filter((session) => session.name !== '');

    const running = async (host: string): Promise<Running[]> => parseListing(await ask(host, 'list', () => {}));

    /**
     * Every session this machine knows of, and what it is working on.
     *
     * A bare list of names could not tell a project's worktree from a home
     * directory, and a project started from here was not in it at all, because
     * only the sessions were written down.
     */
    const inventory = async (only?: string): Promise<string> => {
        const machines =
            only !== undefined
                ? [only]
                : [...new Set([...hosts.values(), ...[...worktrees.values()].map((tree) => tree.host)])];
        if (machines.length === 0) return 'no remote sessions. /remote create <name> <user@host> starts one';

        // Each machine is asked once, and they are asked at the same time.
        const answers = await Promise.all(
            machines.map(async (host) => ({ host, live: await running(host).catch(() => [] as Running[]) })),
        );

        const lines: string[] = [];
        for (const { host, live } of answers) {
            lines.push(`${host}:`);
            if (live.length === 0) {
                lines.push('  nothing running');
                continue;
            }
            for (const session of live) {
                const project = worktrees.get(session.name);
                const where = project !== undefined ? `project, ${project.path}` : session.cwd;
                lines.push(`  ${session.name}${where === '' ? '' : `  ${where}`}`);
            }
        }

        // Written down here but not running there: stopped from somewhere else,
        // or the machine could not be reached. A silent absence reads as a
        // session that was never created.
        const alive = new Set(answers.flatMap(({ live }) => live.map((session) => session.name)));
        const missing = [...new Set([...hosts.keys(), ...worktrees.keys()])].filter((name) => !alive.has(name));
        for (const name of missing) {
            const tree = worktrees.get(name);
            lines.push(`  ${name}  not running${tree === undefined ? '' : `, project at ${tree.path}`}`);
        }
        return lines.join('\n');
    };

    /**
     * The runner on that host, brought up to date.
     *
     * It is installed by content hash, so a newer rho is a different file and
     * the stable name is repointed at it. Done on connect as well as create:
     * the runner is rho's own code and a session started last week should not
     * be attached to by last week's version of it.
     */
    const ensureRunner = async (host: string, say: (note: string) => void): Promise<void> => {
        // One call for the usual case, where the runner is already the current
        // one: it checks and relinks in the same round trip, and only a runner
        // that is genuinely missing costs a second one. Asking separately took
        // three seconds of ssh handshakes to discover that nothing had changed.
        const { path, hash } = await bundle();
        const file = `${REMOTE_DIR}/session-${hash}.js`;
        const quick = [`[ -s ${file} ] || exit 43`, `ln -sf session-${hash}.js ${RUNNER_LINK}`].join('; ');
        const attempt = await run('ssh', [...SSH_FLAGS, host, quick]);
        if (attempt.code === 0) return;
        if (attempt.code !== 43) throw new Error(attempt.err.trim() || `could not reach ${host}`);

        say(`copying the session runner to ${host}`);
        const sent = await run(
            'ssh',
            [
                ...SSH_FLAGS,
                host,
                `mkdir -p ${REMOTE_DIR} && cat > ${file}.part && mv ${file}.part ${file} && ln -sf session-${hash}.js ${RUNNER_LINK}`,
            ],
            readFileSync(path),
        );
        if (sent.code !== 0) throw new Error(`could not copy the session runner: ${sent.err.trim()}`);
    };

    /**
     * The laptop's pi on that host, sent once per version.
     *
     * Returns the path to run, or null when there is nothing to send and the
     * host's own pi has to do. A host with no pi at all can hold a session
     * this way, and two machines that disagree about the version stop
     * disagreeing.
     */
    /**
     * A bun on that host new enough for this pi and for typescript extensions.
     *
     * Returns what to run it with. The host's own is used when it is new
     * enough; otherwise the official build for its architecture is fetched
     * once, kept here, and sent.
     */
    const ensureBun = async (host: string, say: (note: string) => void): Promise<string> => {
        const asked = await run('ssh', [...SSH_FLAGS, host, 'bun --version 2>/dev/null; echo ---; uname -m']);
        const [version = '', machine = ''] = asked.out.split('---');
        if (version.trim() !== '' && newEnough(version)) return 'bun';

        const mine = (await run('bun', ['--version'])).out.trim();
        const arm = machine.trim().startsWith('aarch64') || machine.trim().startsWith('arm64');
        const build = arm ? 'bun-linux-aarch64' : 'bun-linux-x64';
        const remote = `${BUN_DIR}/${mine}/bun`;
        const present = await run('ssh', [...SSH_FLAGS, host, `test -x ${remote} && echo yes || echo no`]);
        if (present.out.trim() === 'yes') return `$HOME/${remote}`;

        const zip = join(CACHE, `${build}-${mine}.zip`);
        if (!existsSync(zip)) {
            say(`fetching bun ${mine} for ${build.replace('bun-linux-', '')}`);
            const url = `https://github.com/oven-sh/bun/releases/download/bun-v${mine}/${build}.zip`;
            const got = await run('curl', ['-sSfL', '-o', zip, url]);
            if (got.code !== 0) throw new Error(`could not fetch bun ${mine}: ${got.err.trim()}`);
        }

        say(`sending bun ${mine} to ${host}`);
        const sent = await run(
            'ssh',
            [
                ...SSH_FLAGS,
                host,
                `mkdir -p $HOME/${BUN_DIR}/${mine} && cat > /tmp/bun-${mine}.zip && ` +
                    `cd $HOME/${BUN_DIR}/${mine} && unzip -oq /tmp/bun-${mine}.zip && ` +
                    `mv ${build}/bun bun && chmod +x bun && rm -rf ${build} /tmp/bun-${mine}.zip`,
            ],
            readFileSync(zip),
        );
        if (sent.code !== 0) throw new Error(`could not send bun to ${host}: ${sent.err.trim()}`);
        return `$HOME/${remote}`;
    };

    const ensurePi = async (host: string, say: (note: string) => void): Promise<string | null> => {
        const version = localPiVersion();
        if (version === null) return null;
        const root = `${PI_DIR}/${version}`;
        const cli = `$HOME/${root}/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`;

        // Installed rather than copied: pi's bundle is not self-contained, and
        // the copy that is enough for bun to auto-install its way through is
        // not enough for node. The package manager already knows how to put
        // exactly this version somewhere.
        const check = `[ -s ${cli} ] && echo yes || echo no`;
        const present = await run('ssh', [...SSH_FLAGS, host, check]);
        if (present.out.trim() === 'yes') return cli;

        say(`installing pi ${version} on ${host}`);
        const install = [
            `mkdir -p $HOME/${root}`,
            `cd $HOME/${root}`,
            `I=$(command -v bun || command -v npm || true)`,
            `[ -n "$I" ] || exit 44`,
            `case "$I" in *bun) "$I" add @earendil-works/pi-coding-agent@${version} ;;`,
            `                *) "$I" install --no-fund --no-audit @earendil-works/pi-coding-agent@${version} ;; esac`,
        ].join('; ');
        const made = await run('ssh', [...SSH_FLAGS, host, install]);
        if (made.code !== 0) throw new Error(`could not install pi ${version} on ${host}: ${made.err.trim()}`);
        return cli;
    };

    /**
     * rho itself on that host, so the agent there is the agent here.
     *
     * Without it the far side is pi with no extensions: none of rho's tools,
     * none of its prompt, and a different agent from the one this machine
     * talks to. The source is a few hundred kilobytes; its dependencies are
     * installed there, which takes about ten seconds the first time.
     *
     * Keyed by the content of what is sent, so an edit here is a different
     * directory there and nothing has to be invalidated by hand.
     */
    const ensureRho = async (host: string, piRoot: string | null, say: (note: string) => void): Promise<string | null> => {
        if (piRoot === null) return null;
        const root = join(remoteDir(), '..', '..', '..');

        // Built here, where bun is. The far side loads it with node, because a
        // host's bun can be older than this pi and the official build will not
        // run on NixOS at all, and node cannot load typescript.
        const packed = join(CACHE, 'remote-rho');
        const made = await run('bun', [join(root, 'bin', 'build-remote-rho'), packed]);
        if (made.code !== 0) throw new Error(`could not build rho for ${host}: ${made.err.trim() || made.out.trim()}`);

        const listing = await run('sh', ['-c', `cd ${JSON.stringify(packed)} && find . -type f | sort`]);
        const digest = createHash('sha256');
        for (const file of listing.out.split('\n').filter((name) => name !== '')) {
            try {
                digest.update(file).update(readFileSync(join(packed, file)));
            } catch {
                // a file that vanished between listing and reading is not sent
            }
        }
        const tag = digest.digest('hex').slice(0, 12);
        const remote = `${RHO_DIR}/${tag}`;
        const present = await run('ssh', [...SSH_FLAGS, host, `test -d ${remote}/extensions && echo yes || echo no`]);
        // The link is remade either way: it points at the pi this session runs,
        // and that pi's directory is where the bundles' externals resolve from.
        const link = `ln -sfn ${piRoot.replace(/\/dist\/bundle\/cli\.js$/, '')}/../.. ${remote}/node_modules`;
        if (present.out.trim() === 'yes') {
            await run('ssh', [...SSH_FLAGS, host, link]);
            return `$HOME/${remote}`;
        }

        say(`sending rho to ${host}`);
        const sent = await run('sh', [
            '-c',
            `tar czf - -C ${JSON.stringify(packed)} . | ssh ${SSH_FLAGS.join(' ')} ${host} ` +
                `'rm -rf ${remote}.part && mkdir -p ${remote}.part && tar xzf - -C ${remote}.part && ` +
                `rm -rf ${remote} && mv ${remote}.part ${remote} && ${link}'`,
        ]);
        if (sent.code !== 0) throw new Error(`could not send rho to ${host}: ${sent.err.trim()}`);
        return `$HOME/${remote}`;
    };

    /**
     * Whether this machine's rho has only just reached that host.
     *
     * rho is sent when a session is created, and an agent keeps the copy it
     * started with: a session made last week is last week's rho, whatever this
     * machine has learnt since. From the interface that is invisible, and it
     * reads as a feature that does not work -- a machine name added since, such
     * as origin, simply is not there.
     *
     * The test needs nothing new on the far side: the build is keyed by its own
     * content, so a directory that is not there yet is a rho no running session
     * can be using.
     */
    const rhoIsNew = async (host: string): Promise<boolean> => {
        const packed = join(CACHE, 'remote-rho');
        const made = await run('bun', [join(remoteDir(), '..', '..', '..', 'bin', 'build-remote-rho'), packed]);
        if (made.code !== 0) return false;
        const listing = await run('sh', ['-c', `cd ${JSON.stringify(packed)} && find . -type f | sort`]);
        const digest = createHash('sha256');
        for (const file of listing.out.split('\n').filter((name) => name !== '')) {
            try {
                digest.update(file).update(readFileSync(join(packed, file)));
            } catch {
                // a file that vanished between listing and reading is not sent
            }
        }
        const tag = digest.digest('hex').slice(0, 12);
        const present = await run('ssh', [...SSH_FLAGS, host, `test -d ${RHO_DIR}/${tag} && echo yes || echo no`]);
        return present.out.trim() === 'no';
    };

    /** Every session a host holds, stopped ones included. */
    const held = async (host: string): Promise<{ name: string; state: 'running' | 'stopped'; cwd: string }[]> => {
        const listed = await ask(host, 'all', () => {}).catch(() => '');
        return listed
            .split('\n')
            .map((line) => line.split('\t'))
            .filter((columns) => columns.length >= 2)
            .map((columns) => ({
                name: columns[0]?.trim() ?? '',
                state: (columns[1]?.trim() === 'running' ? 'running' : 'stopped') as 'running' | 'stopped',
                cwd: columns[2]?.trim() ?? '',
            }))
            .filter((session) => session.name !== '' && session.name !== 'no sessions');
    };

    const list = async (host: string): Promise<string> => {
        const listed = await ask(host, 'list', () => {});
        return listed || 'no sessions';
    };

    /**
     * Attach to a session, starting it if it is not running.
     *
     * A function rather than the body of the connect verb, because the picker
     * offers the same action: /remote manage said enter was connect, drew that
     * on its hint line, and then returned the chosen name to nobody. A label
     * for an action nothing performs is worse than no label.
     */
    /**
     * This interface opening a session file, as connect needs it.
     *
     * `switchSession` belongs to a command handler and to nothing else, so the
     * capability travels as a function rather than being reached for from
     * inside connect.
     */
    const adoptHere =
        (ctx: ExtensionCommandContext): Adopt =>
        async (path, then) => {
            const { cancelled } = await ctx.switchSession(path, {
                withSession: async (fresh) => {
                    then(fresh);
                },
            });
            if (cancelled) throw new Error('this interface would not open the conversation');
        };

    const connectTo = async (
        ctx: ExtensionContext,
        session: string,
        given?: string,
        /**
         * How this interface opens a session file, when there is a way.
         *
         * Only a command handler can replace the session it is running in, so
         * the caller supplies it: typed commands can, and a tool call cannot,
         * which is why the tool asks for the command rather than doing the work
         * itself.
         */
        adopt?: Adopt,
    ): Promise<void> => {
                const address_ = given ?? hosts.get(session) ?? worktrees.get(session)?.host;
                if (address_ === undefined) {
                    ctx.ui.notify(`I do not know which host ${session} is on. /remote connect ${session} user@host`, 'error');
                    return;
                }
                // An address given here is create's argument, so connect takes
                // create's place when there is nothing to connect to: asking
                // for a session is asking for it to exist.
                const host = address_.includes(':') ? address_.slice(0, address_.indexOf(':')) : address_;
                // Running, not merely known: a stopped session is one that has to
                // be started again, and attaching to it found no socket and
                // bounced straight back to this interface.
                const alreadyThere = (await held(host).catch(() => [])).some(
                    (found) => found.name === session && found.state === 'running',
                );
                if (!alreadyThere) {
                    // A project's session belongs in its worktree, which is the
                    // whole point of having made one.
                    const tree = worktrees.get(session);
                    const where = tree === undefined ? address_ : `${tree.host}:${tree.path}`;
                    const bar = progress(ctx);
                    bar.say(`starting ${session} on ${host}`);
                    try {
                        await create(session, where, (text) => bar.say(text));
                    } catch (error) {
                        ctx.ui.notify(`Could not create ${session}: ${(error as Error).message}`, 'error');
                        return;
                    } finally {
                        bar.done();
                    }
                }
                // The terminal is handed over, not described.
                //
                // The interface that draws a remote session is a different
                // process, and this one owns the terminal. Shutting down and
                // spawning it does not work: the child dies with the parent
                // and the window closes. pi already knows how to stand aside
                // for a program that needs the terminal -- it is what it does
                // for an external editor -- so this borrows that: the drawing
                // stops, the client runs in its place, and when it exits the
                // interface comes back exactly as it was.
                // rho's own code on that machine, brought up to date before it
                // is used: a session started last week should not be attached
                // to by last week's runner.
                await ensureRunner(host, () => {}).catch(() => {
                    // An update that cannot be made is not a reason to refuse a
                    // session that is already running.
                });

                /**
                 * A session picks up this machine's rho, the way a local one
                 * picks up an edit when it starts.
                 *
                 * rho is sent to a host when a session is created, and the
                 * agent keeps the copy it started with, so a session made
                 * before a change is running the code from before it and the
                 * change looks broken rather than absent -- the origin machine
                 * was simply not there, with nothing on screen to say why.
                 *
                 * The build is keyed by its own content, so a tag the host has
                 * never seen is a rho no running session can be using. The
                 * session is stopped and started again, which is not
                 * forgetting: the transcript stays and the agent continues it.
                 * A session mid-turn is left alone, because ending somebody's
                 * turn to gain a newer agent is the wrong trade.
                 */
                if (await rhoIsNew(host).catch(() => false)) {
                    const busy = await ask(host, `busy ${session}`, () => {})
                        .then((said) => said.trim() === 'busy')
                        .catch(() => false);
                    if (busy) {
                        ctx.ui.notify(
                            `${session} is mid-turn, so it keeps the rho it started with. Stopping it when the turn ends picks up this machine's.`,
                            'info',
                        );
                    } else {
                        const bar = progress(ctx);
                        bar.say(`bringing ${session} up to date with this machine's rho`);
                        try {
                            await ask(host, `stop ${session}`, () => {});
                            const tree = worktrees.get(session);
                            const where = tree === undefined ? address_ : `${tree.host}:${tree.path}`;
                            await create(session, where, (text) => bar.say(text));
                        } catch (error) {
                            ctx.ui.notify(
                                `${session} could not be brought up to date (${(error as Error).message}), so it is the rho it started with`,
                                'info',
                            );
                        } finally {
                            bar.done();
                        }
                    }
                }

                /**
                 * One conversation, on whichever machine is being used.
                 *
                 * A fresh session there is given what has been said here before
                 * the terminal is handed over, so the agent on the other side
                 * starts knowing everything this one knows rather than being
                 * told again.
                 */
                let joined: Joined = 'apart';
                if (config.remote.carryContext && adopt !== undefined) {
                    const bar = progress(ctx);
                    bar.say(`carrying this conversation to ${session}`);
                    try {
                        joined = await carryUp(ctx, host, session);
                    } catch (error) {
                        ctx.ui.notify(
                            `${session} did not take this conversation (${(error as Error).message}), so it starts with its own`,
                            'info',
                        );
                    } finally {
                        bar.done();
                    }
                }

                const client = join(rhoRoot(), 'bin', 'rho-remote');
                // Why the client left, since the screen it wrote on is redrawn
                // by this interface the moment it returns.
                let left = 0;
                let said = '';
                await ctx.ui.custom<void>(
                    (tui, _theme, _keys, done) => {
                        queueMicrotask(() => {
                            tui.stop();
                            try {
                                // stderr is captured rather than inherited: it is
                                // where the client says why it stopped, and this
                                // interface redraws over it the moment it returns.
                                const ran = spawnSync('bun', [client, host, session], {
                                    stdio: ['inherit', 'inherit', 'pipe'],
                                    encoding: 'utf8',
                                    // Whether the two sides hold one
                                    // conversation, which is what decides
                                    // whether carrying it home is on the menu
                                    // the client draws on the way out.
                                    env: { ...process.env, ...carryEnv(joined !== 'apart') },
                                });
                                left = ran.status ?? 1;
                                said = ran.stderr ?? '';
                            } finally {
                                tui.start();
                                tui.requestRender(true);
                                done();
                            }
                        });
                        return {
                            render: () => [],
                            handleInput: () => {},
                            invalidate: () => {},
                        };
                    },
                    { overlay: true },
                );
                if (left === 0) {
                    // Nothing said is an interface that closed without being
                    // asked: the far side's own rho_leave, or a client from
                    // before the question existed. Both mean carry.
                    const chose = leavingIn(said) ?? 'carry';
                    if (chose === 'exit') {
                        leaveTerminal(ctx, 300, [
                            `${session} keeps running on ${host}.`,
                            ...resumeLines(ctx, session),
                        ]);
                        return;
                    }
                    if (chose === 'leave') {
                        ctx.ui.notify(
                            `back from ${session} on ${host}, which is still running and keeps what was said there. /remote connect ${session} picks it up again`,
                            'info',
                        );
                        return;
                    }
                    // What was said there comes back, so this machine can carry
                    // on from it: the session on the far side keeps running and
                    // holds the same conversation, and connecting again
                    // continues rather than duplicates it.
                    if (joined !== 'apart' && adopt !== undefined) {
                        try {
                            // Says so itself, in the session it opens: this one
                            // is gone by the time it returns.
                            if ((await carryBack(ctx, host, session, adopt)) !== null) return;
                        } catch (error) {
                            ctx.ui.notify(
                                `${session} kept the conversation (${(error as Error).message}): connect again to continue it there`,
                                'error',
                            );
                            return;
                        }
                    }
                    ctx.ui.notify(`back from ${session} on ${host}, which is still running`, 'info');
                    return;
                }
                const trouble = troubleWith(withoutLeaving(said), session, host);
                ctx.ui.notify(
                    trouble.advice === null ? trouble.reason : `${trouble.reason}\n${trouble.advice}`,
                    'error',
                );
                return;
    };

    /**
     * `pi --attach <name>` for a session that is not on this machine.
     *
     * The flag is registered by detach.ts, which knows what a socket here
     * means and nothing about hosts. Connecting is more than a spawn -- the
     * runner is brought up to date, a stopped session is started again, and a
     * host running an older rho is restarted on this one's -- so the flag asks
     * for this rather than reimplementing it.
     */
    publishConnect((ctx, session, host) => connectTo(ctx, session, host));

    pi.registerCommand('remote', {
        description:
            'run the session on another machine: /remote create <name> user@host, /remote connect <name>, /remote list <user@host>',
        /**
         * What can be typed next, which depends on what has been typed.
         *
         * Completing verbs everywhere meant `/remote connect <tab>` offered
         * `create`, and never offered the session you were about to name.
         */
        getArgumentCompletions: (text) => {
            const { before, word } = lastWord(text);
            const first = before.trim().split(/\s+/)[0] ?? '';
            const verb = before.trim() === '' ? null : shorthandFor(first, VERBS);

            const sessionRows = [...new Set([...hosts.keys(), ...worktrees.keys()])].map((name) => ({
                value: name,
                description: worktrees.get(name)?.path ?? hosts.get(name) ?? '',
            }));
            const hostRows = [...new Set(hosts.values())].map((host) => ({ value: host }));

            const offers =
                verb === null
                    ? [...VERBS.map((name) => ({ value: name })), ...sessionRows]
                    : verb === 'connect' || verb === 'stop'
                      ? [...sessionRows, ...hostRows]
                      : verb === 'list' || verb === 'manage' || verb === 'create' || verb === 'project'
                        ? hostRows
                        : [];

            // Whole lines, not bare words: pi replaces the argument text with
            // the value it is given, so a value holding only this word throws
            // away everything typed before it.
            return completeLastWord(`${before}${word}`, offers);
        },
        handler: async (args, ctx) => {
            // `/remote l` is list, `/remote conn` is connect: the first word is
            // read as the shortest thing that still means one of these.
            const spoken = takeVerb(args, VERBS);
            const [first, second] = spoken.rest;
            let verb = spoken.verb;
            if (verb === null && spoken.typed !== '') {
                ctx.ui.notify(spoken.complaint ?? `no such subcommand: ${spoken.typed}`, 'error');
                return;
            }
            // `/remote` on its own is a question about which session, and that
            // is what the list is for: a usage line answers nobody.
            if (verb === null) verb = 'connect';

            if (verb === 'create') {
                if (first === undefined || second === undefined) {
                    ctx.ui.notify('Usage: /remote create <name> user@host[:/path]', 'error');
                    return;
                }
                // Said before the work, because pi takes the input field away
                // while a handler runs: ten seconds of ssh with nothing on
                // screen is indistinguishable from a session that has hung.
                const bar = progress(ctx);
                bar.say(`starting ${first} on ${second}`);
                try {
                    const note = await create(first, second, (text) => bar.say(text));
                    ctx.ui.notify(`${note}. /remote connect ${first} attaches to it.`, 'info');
                } catch (error) {
                    ctx.ui.notify(`Could not create ${first}: ${(error as Error).message}`, 'error');
                } finally {
                    bar.done();
                }
                return;
            }

            if (verb === 'project') {
                // /remote project <repo|project> [branch] [from <base>] [user@host] [as <name>]
                const asked = parseProjectRequest(spoken.rest);
                if (asked === null) {
                    ctx.ui.notify(
                        'Usage: /remote project <repo|project> [branch] [from <base>] [user@host] [as <name>]',
                        'error',
                    );
                    return;
                }
                const host = asked.host ?? [...hosts.values()][0];
                if (host === undefined) {
                    ctx.ui.notify('No host known yet: /remote project <repo|project> [branch] user@host', 'error');
                    return;
                }
                const name = sessionName(asked.source, asked.branch, asked.name ?? undefined);
                const bar = progress(ctx);
                bar.say(`setting up ${name} on ${host}`);
                try {
                    const worktree = await project(host, asked, (note) => bar.say(note));
                    worktrees.set(name, { host, path: worktree });
                    hosts.set(name, host);
                    rememberHosts();
                    ctx.ui.notify(
                        `${name} is at ${worktree} on ${host}. /remote connect ${name} starts a session there.`,
                        'info',
                    );
                } catch (error) {
                    ctx.ui.notify(`Could not set up ${name}: ${(error as Error).message}`, 'error');
                } finally {
                    bar.done();
                }
                return;
            }

            if (verb === 'list') {
                ctx.ui.notify(await inventory(first), 'info');
                return;
            }

            if (verb === 'manage') {
                const host = first ?? [...hosts.values()][0];
                if (host === undefined) {
                    ctx.ui.notify('Usage: /remote manage user@host', 'error');
                    return;
                }
                // Stopping is not forgetting, so the two are different keys and
                // only one of them destroys anything.
                // The keys here are only as new as the runner that answers
                // them, so it is brought up to date before the list is drawn.
                await ensureRunner(host, () => {}).catch(() => {
                    // An update that cannot be made leaves the runner that is
                    // already there, which still lists and still stops.
                });
                let sessions = await held(host);
                const refresh = async () => {
                    sessions = await held(host);
                };
                const chosen = await browse(ctx, {
                    title: `sessions on ${host}`,
                    empty: `nothing on ${host}. /remote create <name> ${host} starts one`,
                    items: () =>
                        sessions.map((session) => ({
                            value: session.name,
                            label: session.name,
                            description: `${session.state}${session.cwd === '' ? '' : `, ${session.cwd}`}${
                                worktrees.has(session.name) ? ', project' : ''
                            }`,
                        })),
                    action: () => ({
                        choose: 'connect',
                        remove: 'stop',
                        removing: 'stopping',
                        extra: [
                            { key: 'r', label: 'rename', id: 'rename', suspends: true },
                            { key: 'x', label: 'forget (deletes the transcript)', id: 'forget', suspends: true },
                            // The same destruction as x, without the question.
                            // Clearing out a host is a run of them, and a
                            // confirmation per row makes that unusable.
                            { key: 'ctrl+d', label: 'delete, no question asked', id: 'delete', busy: 'deleting' },
                        ],
                    }),
                    remove: async (name) => {
                        await ask(host, `stop ${name}`, () => {});
                        await refresh();
                        return true;
                    },
                    extra: async (id, name) => {
                        if (id === 'delete') {
                            // The runner stops it and waits for it to go before
                            // it removes anything: a forget sent straight after
                            // a stop is refused, because the socket still
                            // answers for a moment after the signal.
                            await ask(host, `delete ${name}`, () => {}).catch(() => {
                                // What it says it could not do is said by the
                                // row, which stays when the session stays.
                            });
                            hosts.delete(name);
                            worktrees.delete(name);
                            rememberHosts();
                            await refresh();
                            return true;
                        }
                        if (id === 'rename') {
                            const to = await ctx.ui.input(`rename ${name} to`, name);
                            if (to === undefined || to.trim() === '' || to.trim() === name) return true;
                            const answer = await ask(host, `rename ${name} ${to.trim()}`, () => {}).catch(
                                (trouble: Error) => trouble.message,
                            );
                            ctx.ui.notify(answer, 'info');
                            const where = hosts.get(name);
                            if (where !== undefined) {
                                hosts.delete(name);
                                hosts.set(to.trim(), where);
                            }
                            const tree = worktrees.get(name);
                            if (tree !== undefined) {
                                worktrees.delete(name);
                                worktrees.set(to.trim(), tree);
                            }
                            rememberHosts();
                            await refresh();
                            return true;
                        }
                        // The one that destroys something asks first.
                        const sure = await ctx.ui.confirm(
                            `forget ${name}?`,
                            'this deletes its conversation on that machine. stopping it instead keeps everything.',
                        );
                        if (!sure) return true;
                        const answer = await ask(host, `delete ${name}`, () => {}).catch(
                            (trouble: Error) => trouble.message,
                        );
                        ctx.ui.notify(answer, 'info');
                        hosts.delete(name);
                        worktrees.delete(name);
                        rememberHosts();
                        await refresh();
                        return true;
                    },
                });
                // What the picker chose: enter means connect, and saying so on
                // the hint line while dropping the answer is how this came to
                // look like a picker that does nothing.
                if (chosen !== null) await connectTo(ctx, chosen, undefined, adoptHere(ctx));
                return;
            }

            if (verb === 'connect') {
                const session = first ?? (await chooseSession(ctx, 'connect'));
                if (session === null) return;
                await connectTo(ctx, session, second, adoptHere(ctx));
                return;
            }

            if (verb === 'stop') {
                const session = first ?? (await chooseSession(ctx, 'stop'));
                if (session === null) return;
                const host = hosts.get(session) ?? second;
                if (host === undefined) {
                    ctx.ui.notify(`I do not know which host ${session} is on.`, 'error');
                    return;
                }
                await ask(host, `stop ${session}`, () => {});
                hosts.delete(session);
                rememberHosts();
                ctx.ui.notify(`Stopped ${session}.`, 'info');
                return;
            }

            ctx.ui.notify(
                'Usage: /remote create <name> user@host | /remote connect <name> | /remote list user@host | /remote stop <name>',
                'error',
            );
        },
    });

    // Same reason as the environment tool: described by the skill, loaded when
    // something asks for it rather than carried by every session.
    const OWN = ['remote_session', 'remote_connect'];
    /** Set by the message that asked for these tools, read by the hide below. */
    let asked = false;
    const load = (): void => {
        asked = true;
        const active = pi.getActiveTools();
        const missing = OWN.filter((name) => !active.includes(name));
        if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
    };

    pi.on('input', async (event) => {
        if (/\bremote\b|skill:remote|\bsession on\b/i.test(event.text)) load();
        return { action: 'continue' as const };
    });

    /**
     * A session that is itself a remote session keeps these tools, always.
     *
     * The gate exists so a session that never leaves this machine does not pay
     * for them in its prompt, and it reads the person's message to decide. That
     * reading is wrong on the far side twice over: the agent there is a remote
     * session by construction, and the message that reaches it is often the
     * carried conversation rather than a request mentioning the word. An agent
     * that knew about `remote_connect` from the conversation it arrived with
     * called it and was told the tool does not exist.
     *
     * The broker names the session in the environment of the agent it holds, so
     * the far side can tell what it is without being told.
     */
    // The flag rather than load(): a tool is active from the moment it is
    // registered, the hide below is the only thing that takes it away, and
    // pi's action methods throw while extensions are still loading.
    const heldByRunner = (process.env.RHO_SESSION_NAME ?? '') !== '';
    if (heldByRunner) asked = true;

    // Same as environment.ts: a timer fires during extension loading, where
    // action methods throw and take the session with them.
    let hidden = false;
    pi.on('before_agent_start', async () => {
        if (hidden) return;
        hidden = true;
        // The input handler runs before this one, so on the first message of a
        // session the order was: the message asks for the tools, they are
        // loaded, and this takes them away again -- the one turn that asked for
        // them was the one turn without them, and only the message after it
        // worked. A message that asked keeps what it asked for.
        if (asked) return;
        pi.setActiveTools(pi.getActiveTools().filter((name) => !OWN.includes(name)));
    });

    /**
     * A connection the agent asked for, made once its turn is over.
     *
     * Handing the terminal over in the middle of a tool call would draw another
     * session's interface over a turn that is still running here, and replacing
     * this session's conversation underneath a streaming agent is worse: the
     * file it is appending to would stop being the file it is reading. So the
     * tool records what was asked for and the command that can do it properly
     * runs the moment the session is idle, with the interface free and a
     * command handler's ability to open a different conversation.
     */
    let waiting: string | null = null;
    pi.on('agent_settled', async () => {
        const line = waiting;
        if (line === null) return;
        waiting = null;
        pi.sendUserMessage(line, { expandPromptTemplates: true });
    });

    pi.registerTool({
        name: 'remote_connect',
        label: 'Connect to remote session',
        description:
            'connect puts this terminal in front of a session on another machine, starting it if it is not running; the handover happens as soon as this turn ends. disconnect is the other direction, run from inside a session that somebody is attached to: it sends them back to their own machine. A session that has never been used is given this conversation, and what is said there comes back when the person leaves it, so the two machines hold one thread.',
        promptSnippet: 'Hand this terminal to a session on another machine, or send it back',
        promptGuidelines: [
            'Use remote_connect connect when the work should continue on the other machine with everything said here, rather than as a separate conversation.',
            'Use remote_connect disconnect when the work here is done and the person should be back on their own machine with it.',
        ],
        parameters: Type.Object({
            action: Type.Union([Type.Literal('connect'), Type.Literal('disconnect')], {
                description:
                    'connect: attach this terminal to a session elsewhere. disconnect: from inside a session somebody is attached to, send them back to their own machine',
            }),
            name: Type.Optional(Type.String({ description: 'the session to attach to, for connect' })),
            host: Type.Optional(
                Type.String({ description: 'user@host, optionally with :/path; needed only for a session this machine has not seen' }),
            ),
        }),
        async execute(_id, params: { action: 'connect' | 'disconnect'; name?: string; host?: string }) {
            const said = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });

            if (params.action === 'disconnect') {
                const here = process.env.RHO_SESSION_NAME ?? '';
                const home = process.env.HOME ?? '';
                if (here === '' || home === '') {
                    return said(
                        'This session is not held by a runner, so nobody is attached to it from another machine: it is already running where the interface is.',
                    );
                }
                try {
                    await askInterfaceToLeave(here, home);
                } catch (error) {
                    return said(`Could not send them back: ${(error as Error).message}`);
                }
                return said(
                    `The interface attached to ${here} is leaving. This session keeps running, and what was said in it goes back with them.`,
                );
            }

            if (params.name === undefined) return said('connect needs the name of a session.');
            if ((process.env.RHO_SESSION_NAME ?? '') !== '') {
                return said(
                    'This session has no terminal of its own to hand over: it is drawn by an interface on another machine. Use disconnect to send that interface home, and connect from there.',
                );
            }
            const where = params.host ?? hosts.get(params.name) ?? worktrees.get(params.name)?.host;
            if (where === undefined) {
                return said(`I do not know which host ${params.name} is on: give one as user@host.`);
            }
            waiting = `/remote connect ${params.name} ${where}`;
            return said(
                `${params.name} on ${where} takes this terminal when this turn ends. ` +
                    'Stop here rather than starting other work: the next thing that happens is the handover.',
            );
        },
    });

    pi.registerTool({
        name: 'remote_session',
        label: 'Remote session',
        description:
            'Start or inspect an agent session on another machine, which keeps running when this one stops. create starts a named session; list says what is running there.',
        promptSnippet: 'Run an agent session on a machine that stays up',
        promptGuidelines: [
            'Use remote_session create when work should outlive this session, for example on a host that is never switched off.',
        ],
        parameters: Type.Object({
            action: Type.Union([Type.Literal('create'), Type.Literal('list')]),
            name: Type.Optional(Type.String()),
            host: Type.Optional(Type.String({ description: 'user@host, optionally with :/path' })),
        }),
        async execute(_id, params: { action: 'create' | 'list'; name?: string; host?: string }) {
            const said = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
            try {
                if (params.action === 'list') {
                    if (params.host === undefined) return said('list needs a host.');
                    return said(await list(params.host));
                }
                if (params.name === undefined || params.host === undefined) {
                    return said('create needs a name and a host.');
                }
                return said(await create(params.name, params.host, () => {}));
            } catch (error) {
                return said(`Failed: ${(error as Error).message}`);
            }
        },
    });
}
