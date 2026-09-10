import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOverProcess, operationsFor, waitFor } from '../extensions/lib/remote/client';
import type { Connection } from '../extensions/lib/remote/client';

/**
 * The executor is exercised as a separate process over stdio, because that is
 * how it runs in production. An in-process test would prove the logic and
 * none of the framing, which is where the bugs live.
 */
const ENTRY = join(import.meta.dir, '..', 'extensions', 'lib', 'remote', 'executor-main.ts');

let connection: Connection;
let work: string;

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

const run = async (command: string): Promise<{ code: number | null; out: string }> => {
    const started = await connection.request({ kind: 'spawn', command });
    if (started.kind !== 'spawned') throw new Error(`spawn failed: ${JSON.stringify(started)}`);
    const finished = await waitFor(connection, started.process);
    const out = await connection.request({
        kind: 'read-range',
        process: started.process,
        stream: 'stdout',
        offset: 0,
        length: 1_000_000,
    });
    return { code: finished?.code ?? null, out: out.kind === 'bytes' ? decode(out.data) : '' };
};

beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'rho-remote-'));
    connection = connectOverProcess('test', 'bun', [ENTRY]);
});

afterAll(() => connection.close());

describe('executor', () => {
    test('answers a ping with its version and directory', async () => {
        const reply = await connection.request({ kind: 'ping' });
        expect(reply.kind).toBe('pong');
        if (reply.kind === 'pong') expect(reply.version).toBe(1);
    });

    test('runs a command and returns its output', async () => {
        const { code, out } = await run('echo hello from the executor');
        expect(code).toBe(0);
        expect(out.trim()).toBe('hello from the executor');
    });

    test('reports a non-zero exit rather than swallowing it', async () => {
        const { code } = await run('exit 3');
        expect(code).toBe(3);
    });

    test('the working directory persists between commands', async () => {
        // The whole reason for a resident executor: ssh-per-command cannot do
        // this, because each command is a new shell in a new session.
        expect((await connection.request({ kind: 'chdir', path: work })).kind).toBe('cwd');
        // macOS resolves /var to /private/var, so the tail is what can be
        // compared: the point is that the directory survived, not its spelling.
        const leaf = work.split('/').pop() as string;
        expect((await run('pwd')).out).toContain(leaf);
        expect((await run('echo $PWD')).out).toContain(leaf);
        // And a relative path resolves against it, which is the thing that
        // ssh-per-command cannot do.
        await run('echo persisted > relative.txt');
        expect((await run('cat relative.txt')).out.trim()).toBe('persisted');
    });

    test('output is kept on the far side and read by range', async () => {
        const started = await connection.request({ kind: 'spawn', command: 'printf "%s" ABCDEFGHIJ' });
        if (started.kind !== 'spawned') throw new Error('spawn failed');
        await waitFor(connection, started.process);
        const middle = await connection.request({
            kind: 'read-range',
            process: started.process,
            stream: 'stdout',
            offset: 3,
            length: 4,
        });
        expect(middle.kind).toBe('bytes');
        if (middle.kind === 'bytes') {
            expect(decode(middle.data)).toBe('DEFG');
            expect(middle.eof).toBe(false);
        }
    });

    test('a large output costs a byte count, not the bytes', async () => {
        const started = await connection.request({ kind: 'spawn', command: 'yes long-line | head -c 200000' });
        if (started.kind !== 'spawned') throw new Error('spawn failed');
        const finished = await waitFor(connection, started.process);
        expect(finished?.stdoutBytes).toBe(200_000);
        const head = await connection.request({
            kind: 'read-range',
            process: started.process,
            stream: 'stdout',
            offset: 0,
            length: 50,
        });
        if (head.kind === 'bytes') expect(head.data.byteLength).toBe(50);
    });

    test('stderr is kept apart from stdout', async () => {
        const started = await connection.request({ kind: 'spawn', command: 'echo out; echo err >&2' });
        if (started.kind !== 'spawned') throw new Error('spawn failed');
        await waitFor(connection, started.process);
        const err = await connection.request({
            kind: 'read-range',
            process: started.process,
            stream: 'stderr',
            offset: 0,
            length: 100,
        });
        if (err.kind === 'bytes') expect(decode(err.data).trim()).toBe('err');
    });

    test('a command can be killed', async () => {
        const started = await connection.request({ kind: 'spawn', command: 'sleep 30' });
        if (started.kind !== 'spawned') throw new Error('spawn failed');
        await connection.request({ kind: 'signal', process: started.process, signal: 'KILL' });
        const finished = await waitFor(connection, started.process);
        expect(finished?.signal).toBe('SIGKILL');
    });

    test('a timeout kills a command that will not finish', async () => {
        const started = await connection.request({ kind: 'spawn', command: 'sleep 30', timeout: 300 });
        if (started.kind !== 'spawned') throw new Error('spawn failed');
        const finished = await waitFor(connection, started.process);
        expect(finished?.signal).toBe('SIGKILL');
    });

    test('files are written, read and stat-ed', async () => {
        const path = join(work, 'note.txt');
        expect((await connection.request({ kind: 'write-file', path, data: new TextEncoder().encode('one\ntwo\n') })).kind).toBe('ok');
        const read = await connection.request({ kind: 'read-file', path });
        if (read.kind === 'bytes') expect(decode(read.data)).toBe('one\ntwo\n');
        const info = await connection.request({ kind: 'stat', path });
        if (info.kind === 'stat') {
            expect(info.exists).toBe(true);
            expect(info.bytes).toBe(8);
        }
    });

    test('a missing file stats as absent rather than throwing', async () => {
        const info = await connection.request({ kind: 'stat', path: join(work, 'nothing-here') });
        if (info.kind === 'stat') expect(info.exists).toBe(false);
    });

    test('an edit replaces exact text', async () => {
        const path = join(work, 'edit.txt');
        writeFileSync(path, 'alpha\nbeta\ngamma\n');
        const done = await connection.request({
            kind: 'edit-file',
            path,
            edits: [{ old: 'beta', new: 'BETA' }],
        });
        expect(done.kind).toBe('ok');
        expect(readFileSync(path, 'utf8')).toBe('alpha\nBETA\ngamma\n');
    });

    test('an ambiguous edit is refused, and changes nothing', async () => {
        const path = join(work, 'twice.txt');
        writeFileSync(path, 'same\nsame\n');
        const refused = await connection.request({
            kind: 'edit-file',
            path,
            edits: [{ old: 'same', new: 'other' }],
        });
        expect(refused.kind).toBe('error');
        expect(readFileSync(path, 'utf8')).toBe('same\nsame\n');
    });

    test('an edit that matches nothing is refused', async () => {
        const path = join(work, 'edit.txt');
        const refused = await connection.request({ kind: 'edit-file', path, edits: [{ old: 'absent', new: 'x' }] });
        expect(refused.kind).toBe('error');
    });

    test('a directory lists, and a glob filters', async () => {
        writeFileSync(join(work, 'a.md'), '');
        writeFileSync(join(work, 'b.md'), '');
        const all = await connection.request({ kind: 'list', path: work });
        if (all.kind === 'names') expect(all.names.length).toBeGreaterThanOrEqual(3);
        const filtered = await connection.request({ kind: 'list', path: work, glob: '*.md' });
        if (filtered.kind === 'names') expect([...filtered.names].sort()).toEqual(['a.md', 'b.md']);
    });

    test("pi's bash operations run through the connection", async () => {
        const operations = operationsFor(connection);
        const chunks: string[] = [];
        const result = await operations.bash.exec('echo streamed', work, {
            onData: (chunk) => chunks.push(chunk.toString()),
        });
        expect(result.exitCode).toBe(0);
        expect(chunks.join('').trim()).toBe('streamed');
    });

    test("pi's read and write operations run through the connection", async () => {
        const operations = operationsFor(connection);
        const path = join(work, 'ops.txt');
        await operations.write.writeFile(path, 'through the wire');
        expect((await operations.read.readFile(path)).toString()).toBe('through the wire');
        await expect(operations.read.access(join(work, 'absent'))).rejects.toThrow();
    });
});

describe('a connection that dies', () => {
    test('fails what is waiting instead of hanging', async () => {
        const doomed = connectOverProcess('doomed', 'bun', [ENTRY]);
        const gone = new Promise<string>((settle) => {
            doomed.onEvent((event) => {
                if (event.kind === 'gone') settle(event.why);
            });
        });
        // A rented node disappearing mid-command is the normal case, not an
        // exceptional one, so it has to end as an error and not a hang.
        const pending = doomed.request({ kind: 'spawn', command: 'sleep 60' });
        doomed.close();
        expect(await gone).toContain('gone');
        const reply = await pending;
        expect(reply.kind).toBe('error');
        expect(doomed.alive).toBe(false);
    });

    test('refuses new work once it is gone', async () => {
        const doomed = connectOverProcess('doomed', 'bun', [ENTRY]);
        doomed.close();
        await new Promise((r) => setTimeout(r, 50));
        const reply = await doomed.request({ kind: 'ping' });
        expect(reply.kind).toBe('error');
    });
});
