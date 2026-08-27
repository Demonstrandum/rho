// stop pi-rewind from retrying a checkpoint that has already failed once.
//
// the per-turn checkpoint runs `git add -A -- .` over the whole work tree. a
// work tree holding files this process cannot read fails the same way on every
// turn: git prints permission warnings, `git add` exits non-zero, pi-rewind
// catches it and calls ui.notify with `Checkpoint failed: ...`. a work tree too
// large to stage fails the same way through the engine's own two-minute
// timeout, so each turn also waits two minutes first.
//
// neither condition changes during a session, so the first failure is proof
// that the rest are coming. this patches RepoManager.prototype.stageAll to
// throw at once while the breaker is tripped: no git process, no wait. the
// caller suppresses the repeated notifications.
//
// the class is not exported from pi-rewind's package entry, so the instance
// comes from the one exported function that builds one without side effects,
// resolveSessionCheckpointStorage, imported by file path from the same chunk
// pi-rewind's own entry imports. node keys the module cache on the resolved
// file url, so the prototype patched here is the prototype of the repo object
// pi-rewind is using. `tests/checkpoint-breaker.test.ts` pins the export name,
// which is minified and will move on a pi-rewind release.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHUNK_FILE = '@ayulab__pi-checkpoint.js';

/** the chunk's minified name for `resolveSessionCheckpointStorage`. */
export const RESOLVE_STORAGE_EXPORT = 's';

/** marks a prototype this process has already patched, across /reload. */
const PATCHED = Symbol.for('rho.checkpoint-breaker.patched');

/** what the breaker needs of a repo object: the call every checkpoint makes. */
interface StageAllRepo {
    stageAll(): Promise<void>;
}

interface StorageFound {
    readonly ok: true;
    readonly repo: StageAllRepo;
}

interface StorageMissing {
    readonly ok: false;
    readonly reason: string;
}

type ResolveStorage = (options: {
    sessionFile: string;
    cwd: string;
}) => Promise<StorageFound | StorageMissing>;

export interface SessionStorage {
    readonly sessionFile: string;
    readonly cwd: string;
}

function isStageAllRepo(value: unknown): value is StageAllRepo {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as StageAllRepo).stageAll === 'function'
    );
}

function chunkPath(): string {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve('@ayulab/pi-rewind')), CHUNK_FILE);
}

async function findRepo(storage: SessionStorage): Promise<StageAllRepo | undefined> {
    const module: Record<string, unknown> = await import(pathToFileURL(chunkPath()).href);
    const resolveStorage = module[RESOLVE_STORAGE_EXPORT];
    if (typeof resolveStorage !== 'function') return undefined;
    const result = await (resolveStorage as ResolveStorage)({
        sessionFile: storage.sessionFile,
        cwd: storage.cwd,
    });
    if (!result.ok || !isStageAllRepo(result.repo)) return undefined;
    return result.repo;
}

/**
 * make every later checkpoint fail immediately while `isTripped` is true.
 *
 * returns false when pi-rewind's module no longer has the expected shape, in
 * which case checkpoints keep running and only the notifications can be
 * suppressed. the storage directory must already exist, which it does by the
 * time a checkpoint has failed: the engine creates it before staging.
 */
export async function installCheckpointFastFail(
    storage: SessionStorage,
    isTripped: () => boolean,
    message: string,
): Promise<boolean> {
    let repo: StageAllRepo | undefined;
    try {
        repo = await findRepo(storage);
    } catch {
        return false;
    }
    if (!repo) return false;

    const proto: Record<PropertyKey, unknown> = Object.getPrototypeOf(repo);
    if (proto[PATCHED] === true) return true;

    const original = proto.stageAll;
    if (typeof original !== 'function') return false;
    const stageAll = original as (this: StageAllRepo) => Promise<void>;

    proto.stageAll = async function (this: StageAllRepo): Promise<void> {
        if (isTripped()) throw new Error(message);
        return stageAll.call(this);
    };
    proto[PATCHED] = true;
    return true;
}
