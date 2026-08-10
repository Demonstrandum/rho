#!/usr/bin/env bun
// prompt-explorer: preview, edit, and patch the assembled system prompt.
//
// interactive mode (default):  bun tools/prompt-explorer.ts
// preview mode (no tui):       bun tools/prompt-explorer.ts --preview
//
// the view expands the master template with source annotations. every line
// traces back to its origin file and line number. edits and deletions
// generate per-file patches on quit.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

// ── paths ──────────────────────────────────────────────────

const ROOT = join(import.meta.dir, '..');
const SYSTEM_DIR = join(ROOT, 'system');
const SWAPS_PATH = join(ROOT, 'extensions', 'assets', 'wordswap.json');

// ── types ──────────────────────────────────────────────────

type LineSource =
    | { kind: 'file'; path: string; line: number }
    | { kind: 'swap'; section: 'words' | 'patterns'; key: string }
    | { kind: 'header'; label: string }
    | { kind: 'generated'; label: string };

interface SourceLine {
    text: string;
    source: LineSource;
    deleted: boolean;
    edited: string | null;
}

// ── ansi ───────────────────────────────────────────────────

const CSI = '\x1b[';
const a = {
    clear: `${CSI}2J${CSI}H`,
    clearLine: `${CSI}2K`,
    moveTo: (r: number, c: number) => `${CSI}${r};${c}H`,
    bold: `${CSI}1m`,
    dim: `${CSI}2m`,
    strike: `${CSI}9m`,
    reverse: `${CSI}7m`,
    reset: `${CSI}0m`,
    fg: (n: number) => `${CSI}38;5;${n}m`,
    hideCursor: `${CSI}?25l`,
    showCursor: `${CSI}?25h`,
    altScreen: `${CSI}?1049h`,
    mainScreen: `${CSI}?1049l`,
};

const FILE_COLORS: Record<string, number> = {};
const PALETTE = [6, 3, 5, 2, 4, 1]; // cyan, yellow, magenta, green, blue, red
let colorIdx = 0;

function fileColor(path: string): number {
    if (!(path in FILE_COLORS)) {
        FILE_COLORS[path] = 30 + PALETTE[colorIdx % PALETTE.length];
        colorIdx++;
    }
    return FILE_COLORS[path];
}

// ── source-tracked resolution ──────────────────────────────

interface SwapFile {
    words: Record<string, string>;
    patterns?: Record<string, string>;
}

function loadSwapFile(): SwapFile {
    const raw = JSON.parse(readFileSync(SWAPS_PATH, 'utf8'));
    if (raw && typeof raw === 'object' && !raw.words) {
        return { words: raw as Record<string, string> };
    }
    return raw as SwapFile;
}

function resolveWithSources(): SourceLine[] {
    const lines: SourceLine[] = [];
    const template = readFileSync(join(SYSTEM_DIR, 'prompt.md'), 'utf8');
    const swapFile = loadSwapFile();
    const words = swapFile.words ?? {};
    const patterns = swapFile.patterns ?? {};

    for (const tLine of template.split('\n')) {
        const m = tLine.match(/\{\{include:([^}]+)\}\}/);
        if (!m) continue; // skip blank lines between includes

        const file = m[1].trim();
        const content = readFileSync(join(SYSTEM_DIR, file), 'utf8').trim();

        // file header
        lines.push({
            text: '',
            source: { kind: 'header', label: file },
            deleted: false,
            edited: null,
        });

        for (const [i, fLine] of content.split('\n').entries()) {
            if (fLine.includes('{{WORDS}}')) {
                // expand word swaps, each line traced to wordswap.json
                for (const [key, value] of Object.entries(words)) {
                    lines.push({
                        text: `  - "${key}" -> "${value}"`,
                        source: { kind: 'swap', section: 'words', key },
                        deleted: false,
                        edited: null,
                    });
                }
            } else if (fLine.includes('{{PATTERNS}}')) {
                if (Object.keys(patterns).length > 0) {
                    lines.push({
                        text: '',
                        source: { kind: 'generated', label: 'patterns-spacer' },
                        deleted: false,
                        edited: null,
                    });
                    lines.push({
                        text: 'pattern swaps (regex, applied to coined compounds):',
                        source: { kind: 'generated', label: 'patterns-header' },
                        deleted: false,
                        edited: null,
                    });
                    lines.push({
                        text: '',
                        source: { kind: 'generated', label: 'patterns-spacer' },
                        deleted: false,
                        edited: null,
                    });
                    for (const [src, repl] of Object.entries(patterns)) {
                        lines.push({
                            text: `  - /${src}/ -> "${repl}"`,
                            source: { kind: 'swap', section: 'patterns', key: src },
                            deleted: false,
                            edited: null,
                        });
                    }
                }
            } else {
                lines.push({
                    text: fLine,
                    source: { kind: 'file', path: file, line: i + 1 },
                    deleted: false,
                    edited: null,
                });
            }
        }
    }

    return lines;
}

// ── source label ───────────────────────────────────────────

function sourceLabel(src: LineSource): string {
    switch (src.kind) {
        case 'file':
            return `${src.path}:${src.line}`;
        case 'swap':
            return `wordswap.json:${src.section}.${src.key}`;
        case 'header':
            return src.label;
        case 'generated':
            return `(${src.label})`;
    }
}

// ── diff generation ────────────────────────────────────────

function currentText(line: SourceLine): string {
    if (line.deleted) return '';
    return line.edited ?? line.text;
}

function hasChanges(lines: SourceLine[]): boolean {
    return lines.some((l) => l.deleted || l.edited !== null);
}

interface FileChange {
    originalPath: string;
    originalContent: string;
    modifiedContent: string;
}

function collectFileChanges(lines: SourceLine[]): FileChange[] {
    const changes: FileChange[] = [];

    // group file-sourced changes by path
    const filePaths = new Set<string>();
    for (const l of lines) {
        if (l.source.kind === 'file' && (l.deleted || l.edited !== null)) {
            filePaths.add(l.source.path);
        }
    }

    for (const path of filePaths) {
        const fullPath = join(SYSTEM_DIR, path);
        const original = readFileSync(fullPath, 'utf8');
        const originalLines = original.split('\n');
        const modified = [...originalLines];

        // collect all changes for this file, process in reverse line order
        // so deletions don't shift indices.
        const fileChanges: Array<{ line: number; deleted: boolean; edited: string | null }> = [];
        for (const l of lines) {
            if (l.source.kind === 'file' && l.source.path === path && (l.deleted || l.edited !== null)) {
                fileChanges.push({ line: l.source.line, deleted: l.deleted, edited: l.edited });
            }
        }
        fileChanges.sort((x, y) => y.line - x.line);

        for (const c of fileChanges) {
            const idx = c.line - 1;
            if (c.deleted) {
                modified.splice(idx, 1);
            } else if (c.edited !== null) {
                modified[idx] = c.edited;
            }
        }

        if (original !== modified.join('\n')) {
            changes.push({
                originalPath: relative(ROOT, fullPath),
                originalContent: original,
                modifiedContent: modified.join('\n'),
            });
        }
    }

    // wordswap.json changes
    const swapChanges = lines.filter(
        (l) => l.source.kind === 'swap' && (l.deleted || l.edited !== null),
    );
    if (swapChanges.length > 0) {
        const original = readFileSync(SWAPS_PATH, 'utf8');
        const swapFile = loadSwapFile();
        const newWords = { ...swapFile.words };
        const newPatterns = { ...(swapFile.patterns ?? {}) };

        for (const l of swapChanges) {
            const src = l.source as { kind: 'swap'; section: 'words' | 'patterns'; key: string };
            if (l.deleted) {
                if (src.section === 'words') delete newWords[src.key];
                else delete newPatterns[src.key];
            } else if (l.edited !== null) {
                // parse edited line to extract new key/value
                const parsed = parseSwapLine(l.edited, src.section);
                if (parsed) {
                    if (src.section === 'words') {
                        delete newWords[src.key];
                        newWords[parsed.key] = parsed.value;
                    } else {
                        delete newPatterns[src.key];
                        newPatterns[parsed.key] = parsed.value;
                    }
                }
            }
        }

        const newFile: SwapFile = { words: newWords };
        if (Object.keys(newPatterns).length > 0) newFile.patterns = newPatterns;
        const modified = JSON.stringify(newFile, null, 4) + '\n';

        if (original !== modified) {
            changes.push({
                originalPath: relative(ROOT, SWAPS_PATH),
                originalContent: original,
                modifiedContent: modified,
            });
        }
    }

    return changes;
}

function parseSwapLine(
    text: string,
    section: 'words' | 'patterns',
): { key: string; value: string } | null {
    if (section === 'words') {
        const m = text.match(/^\s*-\s*"([^"]+)"\s*->\s*"([^"]+)"\s*$/);
        return m ? { key: m[1], value: m[2] } : null;
    }
    const m = text.match(/^\s*-\s*\/([^/]+)\/\s*->\s*"([^"]+)"\s*$/);
    return m ? { key: m[1], value: m[2] } : null;
}

function generateDiffs(changes: FileChange[]): string {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-explorer-'));
    const parts: string[] = [];

    for (const c of changes) {
        const origFile = join(tmp, 'original');
        const modFile = join(tmp, 'modified');
        writeFileSync(origFile, c.originalContent);
        writeFileSync(modFile, c.modifiedContent);

        try {
            execSync(`diff -u "${origFile}" "${modFile}"`, { encoding: 'utf8' });
        } catch (e: unknown) {
            // diff exits 1 when files differ
            const err = e as { stdout?: string };
            if (err.stdout) {
                // replace temp paths with real paths in header
                const diff = err.stdout
                    .replace(/^--- .*$/m, `--- a/${c.originalPath}`)
                    .replace(/^\+\+\+ .*$/m, `+++ b/${c.originalPath}`);
                parts.push(diff);
            }
        }
    }

    return parts.join('\n');
}

// ── preview mode ───────────────────────────────────────────

function preview(lines: SourceLine[]): void {
    const w = process.stdout.columns || 80;

    for (const l of lines) {
        if (l.source.kind === 'header') {
            const label = ` ${l.source.label} `;
            const pad = Math.max(0, w - label.length - 4);
            console.log(`${a.bold}${a.fg(fileColor(l.source.label))}${'─'.repeat(2)}${label}${'─'.repeat(pad)}${a.reset}`);
            continue;
        }

        const gutter = l.source.kind === 'file'
            ? String(l.source.line).padStart(4)
            : l.source.kind === 'swap'
                ? '   ~'
                : '    ';

        const marker = l.deleted ? `${a.dim}${a.strike}` : l.edited !== null ? `${a.fg(3)}` : '';
        const text = l.edited ?? l.text;
        console.log(`${a.dim}${gutter} │${a.reset} ${marker}${text}${a.reset}`);
    }
}

// ── interactive explorer ───────────────────────────────────

class Explorer {
    private lines: SourceLine[];
    private cursor = 0;
    private scroll = 0;
    private undoStack: Array<{ index: number; deleted: boolean; edited: string | null }> = [];
    private message = '';
    private editMode = false;
    private editBuffer = '';
    private editCursor = 0;
    private searchMode = false;
    private searchBuffer = '';
    private quit = false;

    constructor(lines: SourceLine[]) {
        this.lines = lines;
        // start cursor on first content line
        this.cursor = this.nextContent(-1, 1);
    }

    private get rows(): number {
        return (process.stdout.rows || 24) - 2;
    }

    private get cols(): number {
        return process.stdout.columns || 80;
    }

    private isContent(i: number): boolean {
        const src = this.lines[i]?.source;
        return src !== undefined && src.kind !== 'header';
    }

    private nextContent(from: number, dir: 1 | -1): number {
        let i = from + dir;
        while (i >= 0 && i < this.lines.length) {
            if (this.isContent(i)) return i;
            i += dir;
        }
        return from;
    }

    private changeCount(): { deleted: number; modified: number } {
        let deleted = 0;
        let modified = 0;
        for (const l of this.lines) {
            if (l.deleted) deleted++;
            else if (l.edited !== null) modified++;
        }
        return { deleted, modified };
    }

    private ensureVisible(): void {
        if (this.cursor < this.scroll) this.scroll = this.cursor;
        if (this.cursor >= this.scroll + this.rows) this.scroll = this.cursor - this.rows + 1;
        // also show the header above if cursor is the first line after one
        if (this.scroll > 0 && this.lines[this.scroll - 1]?.source.kind === 'header') {
            this.scroll--;
        }
    }

    render(): void {
        const w = this.cols;
        const gutterW = 6; // "  NNN "
        let out = a.moveTo(1, 1);

        for (let row = 0; row < this.rows; row++) {
            const i = this.scroll + row;
            out += a.clearLine;

            if (i >= this.lines.length) {
                out += `${a.dim}~${a.reset}`;
            } else {
                const l = this.lines[i];

                if (l.source.kind === 'header') {
                    const label = ` ${l.source.label} `;
                    const color = fileColor(l.source.label);
                    const pad = Math.max(0, w - label.length - 4);
                    out += `${a.bold}${a.fg(color)}${'─'.repeat(2)}${label}${'─'.repeat(pad)}${a.reset}`;
                } else {
                    const isCursor = i === this.cursor;
                    const gutter = l.source.kind === 'file'
                        ? String(l.source.line).padStart(4)
                        : l.source.kind === 'swap'
                            ? '   ~'
                            : '    ';

                    let lineText: string;
                    if (this.editMode && isCursor) {
                        // show edit buffer with cursor
                        const before = this.editBuffer.slice(0, this.editCursor);
                        const cursorChar = this.editBuffer[this.editCursor] ?? ' ';
                        const after = this.editBuffer.slice(this.editCursor + 1);
                        lineText = `${before}${a.reverse}${cursorChar}${a.reset}${after}`;
                    } else {
                        lineText = l.edited ?? l.text;
                    }

                    let style = '';
                    if (l.deleted) style = `${a.dim}${a.strike}`;
                    else if (l.edited !== null) style = `${a.fg(3)}`; // yellow

                    const prefix = l.deleted ? 'x' : l.edited !== null ? '*' : ' ';
                    const cursorMark = isCursor && !this.editMode ? `${a.reverse}` : '';
                    const cursorEnd = isCursor && !this.editMode ? `${a.reset}` : '';

                    out += `${a.dim}${prefix}${gutter} │${a.reset} ${cursorMark}${style}${lineText}${cursorEnd}${a.reset}`;
                }
            }

            out += '\n';
        }

        // status bar (two lines at bottom)
        const { deleted, modified } = this.changeCount();
        const cur = this.lines[this.cursor];
        const pos = cur ? sourceLabel(cur.source) : '';
        const total = this.lines.filter((l) => l.source.kind !== 'header').length;

        out += a.clearLine;
        out += `${a.reverse} ${pos} ${a.reset}`;
        out += `${a.dim}  lines: ${total}`;
        if (deleted > 0) out += `  ${a.fg(1)}del: ${deleted}${a.dim}`;
        if (modified > 0) out += `  ${a.fg(3)}mod: ${modified}${a.dim}`;
        out += `${a.reset}\n`;

        out += a.clearLine;
        if (this.searchMode) {
            out += `${a.reverse} / ${a.reset} ${this.searchBuffer}`;
        } else if (this.message) {
            out += `${a.fg(3)} ${this.message}${a.reset}`;
            this.message = '';
        } else {
            out += `${a.dim} d delete  e edit  u undo  / search  n next  D diff  w write  q quit${a.reset}`;
        }

        process.stdout.write(out);
    }

    handleKey(buf: Buffer): void {
        const key = buf.toString('utf8');
        const seq = buf.length > 1 ? buf.toString('hex') : '';

        if (this.searchMode) {
            this.handleSearchKey(key, buf);
            return;
        }

        if (this.editMode) {
            this.handleEditKey(key, buf, seq);
            return;
        }

        // navigation
        if (key === 'k' || seq === '1b5b41') { // up
            this.cursor = this.nextContent(this.cursor, -1);
            this.ensureVisible();
        } else if (key === 'j' || seq === '1b5b42') { // down
            this.cursor = this.nextContent(this.cursor, 1);
            this.ensureVisible();
        } else if (seq === '1b5b357e' || key === '\x15') { // page up, ctrl-u
            for (let i = 0; i < this.rows - 2; i++) {
                this.cursor = this.nextContent(this.cursor, -1);
            }
            this.ensureVisible();
        } else if (seq === '1b5b367e' || key === '\x04') { // page down, ctrl-d
            for (let i = 0; i < this.rows - 2; i++) {
                this.cursor = this.nextContent(this.cursor, 1);
            }
            this.ensureVisible();
        } else if (key === 'g') { // top
            this.cursor = this.nextContent(-1, 1);
            this.ensureVisible();
        } else if (key === 'G') { // bottom
            this.cursor = this.nextContent(this.lines.length, -1);
            this.ensureVisible();
        }

        // actions
        else if (key === 'd') {
            const l = this.lines[this.cursor];
            if (l && this.isContent(this.cursor) && l.source.kind !== 'generated') {
                this.undoStack.push({ index: this.cursor, deleted: l.deleted, edited: l.edited });
                l.deleted = !l.deleted;
            }
        } else if (key === 'e') {
            const l = this.lines[this.cursor];
            if (l && this.isContent(this.cursor) && l.source.kind !== 'generated' && !l.deleted) {
                this.editMode = true;
                this.editBuffer = l.edited ?? l.text;
                this.editCursor = this.editBuffer.length;
            }
        } else if (key === 'u') {
            const op = this.undoStack.pop();
            if (op) {
                this.lines[op.index].deleted = op.deleted;
                this.lines[op.index].edited = op.edited;
                this.cursor = op.index;
                this.ensureVisible();
            } else {
                this.message = 'nothing to undo';
            }
        } else if (key === '/') {
            this.searchMode = true;
            this.searchBuffer = '';
        } else if (key === 'n') {
            this.searchNext(1);
        } else if (key === 'N') {
            this.searchNext(-1);
        } else if (key === 'D') {
            this.showDiff();
        } else if (key === 'w') {
            this.writePatch();
        } else if (key === 'q' || key === '\x03') { // q or ctrl-c
            this.quit = true;
        }
    }

    private handleSearchKey(key: string, buf: Buffer): void {
        if (key === '\r' || key === '\n') { // enter
            this.searchMode = false;
            if (this.searchBuffer) this.searchNext(1);
        } else if (key === '\x1b' || key === '\x03') { // escape or ctrl-c
            this.searchMode = false;
            this.searchBuffer = '';
        } else if (key === '\x7f' || key === '\b') { // backspace
            this.searchBuffer = this.searchBuffer.slice(0, -1);
        } else if (buf.length === 1 && buf[0] >= 0x20) {
            this.searchBuffer += key;
        }
    }

    private handleEditKey(key: string, _buf: Buffer, seq: string): void {
        if (key === '\r' || key === '\n') { // enter: confirm
            const l = this.lines[this.cursor];
            this.undoStack.push({ index: this.cursor, deleted: l.deleted, edited: l.edited });
            l.edited = this.editBuffer === l.text ? null : this.editBuffer;
            this.editMode = false;
        } else if (key === '\x1b' && seq === '1b') { // bare escape: cancel
            this.editMode = false;
        } else if (seq === '1b5b44') { // left
            if (this.editCursor > 0) this.editCursor--;
        } else if (seq === '1b5b43') { // right
            if (this.editCursor < this.editBuffer.length) this.editCursor++;
        } else if (seq === '1b5b48' || key === '\x01') { // home or ctrl-a
            this.editCursor = 0;
        } else if (seq === '1b5b46' || key === '\x05') { // end or ctrl-e
            this.editCursor = this.editBuffer.length;
        } else if (key === '\x7f' || key === '\b') { // backspace
            if (this.editCursor > 0) {
                this.editBuffer =
                    this.editBuffer.slice(0, this.editCursor - 1) +
                    this.editBuffer.slice(this.editCursor);
                this.editCursor--;
            }
        } else if (seq === '1b5b337e') { // delete key
            if (this.editCursor < this.editBuffer.length) {
                this.editBuffer =
                    this.editBuffer.slice(0, this.editCursor) +
                    this.editBuffer.slice(this.editCursor + 1);
            }
        } else if (key.length === 1 && key.charCodeAt(0) >= 0x20) {
            this.editBuffer =
                this.editBuffer.slice(0, this.editCursor) +
                key +
                this.editBuffer.slice(this.editCursor);
            this.editCursor++;
        }
        // swallow other escape sequences in edit mode
    }

    private searchNext(dir: 1 | -1): void {
        if (!this.searchBuffer) {
            this.message = 'no search query';
            return;
        }
        const q = this.searchBuffer.toLowerCase();
        let i = this.cursor + dir;
        const len = this.lines.length;
        let checked = 0;
        while (checked < len) {
            if (i < 0) i = len - 1;
            if (i >= len) i = 0;
            const l = this.lines[i];
            if (this.isContent(i) && (l.edited ?? l.text).toLowerCase().includes(q)) {
                this.cursor = i;
                this.ensureVisible();
                return;
            }
            i += dir;
            checked++;
        }
        this.message = `"${this.searchBuffer}" not found`;
    }

    private showDiff(): void {
        if (!hasChanges(this.lines)) {
            this.message = 'no changes';
            return;
        }
        const changes = collectFileChanges(this.lines);
        if (changes.length === 0) {
            this.message = 'no effective changes';
            return;
        }
        const diff = generateDiffs(changes);

        // temporarily leave alt screen to show diff
        process.stdout.write(a.mainScreen + a.showCursor);
        console.log(diff);
        console.log(`${a.dim}(press any key to return)${a.reset}`);

        // wait for a key synchronously
        const b = Buffer.alloc(64);
        const fd = process.stdin.fd;
        try {
            const { readSync } = require('node:fs');
            readSync(fd, b, 0, 64);
        } catch { /* */ }

        process.stdout.write(a.altScreen + a.hideCursor);
    }

    private writePatch(): void {
        if (!hasChanges(this.lines)) {
            this.message = 'no changes to write';
            return;
        }
        const changes = collectFileChanges(this.lines);
        if (changes.length === 0) {
            this.message = 'no effective changes';
            return;
        }
        const diff = generateDiffs(changes);
        const patchFile = join(ROOT, 'prompt-explorer.patch');
        writeFileSync(patchFile, diff);
        this.message = `patch written to prompt-explorer.patch (${changes.length} file(s))`;
    }

    async run(): Promise<void> {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdout.write(a.altScreen + a.hideCursor);

        this.render();

        for await (const chunk of process.stdin) {
            const buf = chunk as Buffer;
            this.handleKey(buf);
            if (this.quit) break;
            this.render();
        }

        process.stdout.write(a.mainScreen + a.showCursor);
        process.stdin.setRawMode(false);
        process.stdin.pause();

        if (hasChanges(this.lines)) {
            const changes = collectFileChanges(this.lines);
            if (changes.length > 0) {
                const diff = generateDiffs(changes);
                console.log(diff);
                console.log(`${a.dim}apply with: git apply prompt-explorer.patch${a.reset}`);
            }
        }
    }
}

// ── main ───────────────────────────────────────────────────

const lines = resolveWithSources();

if (process.argv.includes('--preview')) {
    preview(lines);
    process.exit(0);
}

const explorer = new Explorer(lines);
await explorer.run();
