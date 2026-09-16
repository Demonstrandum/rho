// writing a whole session tree to a new file.
//
// pi's own copies (`/fork`, `/clone`, SessionManager.createBranchedSession)
// keep one root-to-leaf path, because both commands exist to start a new line
// of work. the copies here keep every branch, which is what makes an edit
// reversible: the file being edited is never written, the edited tree lands
// beside it, and the header's parentSession says where it came from.
//
// the format is the one in docs/session-format.md: a header line, then one
// entry per line, in file order. entry ids are kept as they are, so a label,
// a compaction, and a branch summary still name what they named.

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_SESSION_VERSION, type SessionEntry, type SessionHeader } from '@earendil-works/pi-coding-agent';

export interface SessionWrite {
    /** directory sessions for this project live in. */
    readonly sessionDir: string;
    /** working directory recorded in the header. */
    readonly cwd: string;
    /** file the copy came from, recorded as its parent. */
    readonly parentSession?: string;
    readonly entries: readonly SessionEntry[];
}

/** the name pi gives a session file: an ISO timestamp, then the session id. */
export function sessionFileName(id: string, at: Date): string {
    return `${at.toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`;
}

/** serialise a header and entries as the JSONL a session file holds. */
export function sessionLines(header: SessionHeader, entries: readonly SessionEntry[]): string {
    return [header, ...entries].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

/** write a whole tree to a new session file, and return its path. */
export function writeSessionCopy(write: SessionWrite): string {
    const at = new Date();
    const id = randomUUID();
    const header: SessionHeader = {
        type: 'session',
        version: CURRENT_SESSION_VERSION,
        id,
        timestamp: at.toISOString(),
        cwd: write.cwd,
        ...(write.parentSession !== undefined && { parentSession: write.parentSession }),
    };
    const path = join(write.sessionDir, sessionFileName(id, at));
    writeFileSync(path, sessionLines(header, write.entries), 'utf8');
    return path;
}
