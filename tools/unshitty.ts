#!/usr/bin/env bun
// bun run unshitty [--head] [--plain] [--keep]
// diffs the system prompt a real session sends against the same text after
// extensions/lib/disenshittification.ts has run over it. the session applies
// that rewrite itself, through extensions/prompt-disenshittify.ts, so the
// capture below disables it and applies the transform here instead: what the
// diff shows is what the extension does. the anthropic block
// ("You are Claude Code, ...") is a separate system block added by the
// transport, never reaches this text, and so is never touched.
//
//   --head    diff pi's own head only, not the rho fragments below it
//   --plain   no colour, for piping
//   --keep    leave the two temporary files on disk and print their paths
//
// $DIFF picks the tool and may carry its own arguments:
//
//   DIFF=opendiff bun run unshitty          FileMerge
//   DIFF='delta --side-by-side' ...         delta
//   DIFF='git diff --no-index' ...          git's differ
//
// a tool that opens a window rather than writing to stdout keeps its input
// files: they are named on exit so a detached window still has them.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disenshittifyMarkdown } from '../extensions/lib/disenshittification';

/** the last line pi's own head emits; everything after it comes from elsewhere. */
const HEAD_END = /- (?:Always read pi \.md files completely|always read pi \.md files completely)[^\n]*/;

// the transport adds this as its own system block when the token is an oauth
// one. it is anthropic's text, it is what keeps the request on plan billing,
// and nothing here may rewrite it. see extensions/prompt-defingerprint.ts.
const VENDOR_BLOCK = /^You are Claude Code, Anthropic's official CLI for Claude\.$/;

interface SystemBlock {
    readonly text: string;
}

const isSystemBlock = (value: unknown): value is SystemBlock =>
    typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string';

/** every system block pi owns, the vendor block excluded. */
const ownedBlocks = (payload: unknown): string[] => {
    const system = (payload as { system?: unknown } | null)?.system;
    const blocks =
        typeof system === 'string'
            ? [system]
            : Array.isArray(system)
              ? system.map((block) => (isSystemBlock(block) ? block.text : String(block)))
              : [];
    return blocks.filter((text) => !VENDOR_BLOCK.test(text.trim()));
};

const capturePrompt = async (): Promise<string> => {
    const proc = Bun.spawn(['bun', join(import.meta.dir, 'prompt-full.ts'), '--json'], {
        stdout: 'pipe',
        stderr: 'inherit',
        env: { ...process.env, RHO_DISENSHITTIFY_OFF: '1' },
    });
    const raw = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
        console.error(`prompt-full.ts exited ${code}`);
        process.exit(code);
    }
    const blocks = ownedBlocks(JSON.parse(raw));
    if (blocks.length === 0) {
        console.error('payload carried no system block pi owns; run bun run prompt:full:json to see its shape.');
        process.exit(1);
    }
    return blocks.join('\n').trim();
};

/** a command line as written in $DIFF, split on spaces outside quotes. */
const splitCommand = (source: string): string[] =>
    (source.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((token) => token.replace(/["']/g, ''));

// these open a window instead of writing to stdout, so their input files must
// outlive this process.
const WINDOWED = new Set(['opendiff', 'ksdiff', 'bcompare', 'meld', 'kdiff3', 'araxis', 'p4merge', 'vimdiff', 'nvim', 'vim', 'code']);

interface DiffTool {
    readonly command: readonly string[];
    /** true when the tool needs its input files after this process exits. */
    readonly windowed: boolean;
}

const diffTool = (plain: boolean): DiffTool => {
    const configured = process.env['DIFF']?.trim();
    if (configured === undefined || configured.length === 0) {
        return {
            command: ['diff', '-u', '--label', 'original', '--label', 'unshitty', `--color=${plain ? 'never' : 'auto'}`],
            windowed: false,
        };
    }
    const command = splitCommand(configured);
    const name = (command[0] ?? '').split('/').pop() ?? '';
    return { command, windowed: WINDOWED.has(name) };
};

const main = async (): Promise<void> => {
    const args = new Set(process.argv.slice(2));
    const full = await capturePrompt();

    const boundary = HEAD_END.exec(full);
    const cut = args.has('--head') && boundary !== null ? boundary.index + boundary[0].length : full.length;
    const before = full.slice(0, cut);
    const after = disenshittifyMarkdown(before);

    if (before === after) {
        console.log('unchanged');
        return;
    }

    const dir = mkdtempSync(join(tmpdir(), 'rho-unshitty-'));
    let keep = false;
    try {
        const beforePath = join(dir, 'prompt.original.md');
        const afterPath = join(dir, 'prompt.unshitty.md');
        writeFileSync(beforePath, before);
        writeFileSync(afterPath, after);

        const tool = diffTool(args.has('--plain'));
        const run = Bun.spawnSync([...tool.command, beforePath, afterPath], { stdout: 'inherit', stderr: 'inherit' });
        // a differ exits 1 when the files differ, which is the expected case here.
        if (run.exitCode > 1) console.error(`${tool.command[0]} exited ${run.exitCode}`);

        const changed = after.split('\n').length - before.split('\n').length;
        console.log(`\n${before.length} -> ${after.length} chars, ${changed >= 0 ? '+' : ''}${changed} lines`);
        console.log(disenshittifyMarkdown(after) === after ? 'idempotent' : 'NOT IDEMPOTENT');

        keep = tool.windowed || args.has('--keep');
        if (keep) console.log(`${beforePath}\n${afterPath}`);
    } finally {
        if (!keep) rmSync(dir, { recursive: true, force: true });
    }
};

await main();
