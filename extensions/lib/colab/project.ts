// What a project already has for working in its notebooks.
//
// A repository that has lived with marimo for a while grows a layer of its
// own: a module the agent is meant to act through (one that imports
// marimo._code_mode and wraps it in named calls), a skill stating the
// conventions, launch scripts, widgets, a directory of notebooks per person.
// An agent that arrives with generic tools and builds a figure beside that
// layer has replicated it badly; it should have read the skill, called the
// module, and extended the widget. This finds the layer so the tools can
// point at it before the first edit.
//
// Detection is by content, not by name: a file that imports the private
// code-mode module is an agent layer whatever it is called.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export interface ProjectLab {
    /** python modules that import marimo._code_mode: the project's agent api. */
    readonly agentModules: readonly AgentModule[];
    /** skill files that mention marimo, colab or notebooks. */
    readonly skills: readonly string[];
    /** shell or python entry points that start marimo. */
    readonly launchers: readonly string[];
    /** directories holding anywidget or other custom widgets. */
    readonly widgetDirs: readonly string[];
    /** directories holding marimo notebooks, with how many. */
    readonly notebookDirs: readonly { path: string; count: number }[];
}

export interface AgentModule {
    readonly path: string;
    /** dotted import path from the project root, when it is importable that way. */
    readonly importPath: string | null;
    /** top-level def names, async or not, without a leading underscore. */
    readonly functions: readonly string[];
}

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.marimo', '__marimo__', 'site-packages', '.rho', '.pi']);
const MAX_DEPTH = 4;
const MAX_FILES = 12_000;

/** breadth first, so a shallow layer is found before a deep results tree spends the budget. */
function* walk(root: string): Generator<string> {
    let left = MAX_FILES;
    let level: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
    while (level.length > 0 && left > 0) {
        const next: { path: string; depth: number }[] = [];
        for (const { path: dir, depth } of level) {
            let entries: string[];
            try {
                entries = readdirSync(dir);
            } catch {
                continue;
            }
            for (const name of entries) {
                if (SKIP.has(name)) continue;
                const path = join(dir, name);
                let stat;
                try {
                    stat = statSync(path);
                } catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    if (depth + 1 <= MAX_DEPTH) next.push({ path, depth: depth + 1 });
                } else if (stat.isFile()) {
                    left -= 1;
                    if (left < 0) return;
                    yield path;
                }
            }
        }
        level = next;
    }
}

const head = (path: string, bytes = 64_000): string => {
    try {
        return readFileSync(path, 'utf8').slice(0, bytes);
    } catch {
        return '';
    }
};

const importPathFor = (root: string, path: string): string | null => {
    const rel = relative(root, path).replace(/\.py$/, '');
    if (rel.startsWith('..') || /[^A-Za-z0-9_/]/.test(rel)) return null;
    const parts = rel.split('/');
    // every directory on the way needs an __init__.py to be a package
    for (let i = 1; i < parts.length; i++) {
        if (!existsSync(join(root, ...parts.slice(0, i), '__init__.py'))) return null;
    }
    const dotted = parts.join('.');
    return dotted.endsWith('.__init__') ? dotted.slice(0, -'.__init__'.length) : dotted;
};

export function inspectProject(root: string): ProjectLab {
    const agentModules: AgentModule[] = [];
    const skills: string[] = [];
    const launchers: string[] = [];
    const widgetDirs = new Set<string>();
    const notebooks = new Map<string, number>();
    for (const path of walk(root)) {
        const name = basename(path);
        if (name.endsWith('.py')) {
            const text = head(path);
            if (/^import marimo\b/m.test(text) && /marimo\.App\(/.test(text)) {
                const dir = relative(root, join(path, '..')) || '.';
                notebooks.set(dir, (notebooks.get(dir) ?? 0) + 1);
                continue;
            }
            if (/marimo\._code_mode/.test(text)) {
                const functions = [...text.matchAll(/^(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(/gm)].map((m) => m[1]!);
                agentModules.push({ path: relative(root, path), importPath: importPathFor(root, path), functions });
            }
            if (/anywidget/.test(text)) widgetDirs.add(relative(root, join(path, '..')) || '.');
        } else if (name === 'SKILL.md') {
            if (/\bmarimo\b|\bcolab\b|\bnotebook/i.test(head(path, 8_000))) skills.push(relative(root, path));
        } else if (/\.(sh|mjs|js|ts)$/.test(name) || (!name.includes('.') && statSync(path).mode & 0o111)) {
            const text = head(path, 8_000);
            if (/\bmarimo (edit|run)\b|marimo\/(edit|run)|\/api\/kernel|kiosk=true|marimo-cell|#cell-/.test(text)) launchers.push(relative(root, path));
        }
    }
    return {
        agentModules,
        skills,
        launchers,
        widgetDirs: [...widgetDirs],
        notebookDirs: [...notebooks.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count),
    };
}

export const hasLab = (lab: ProjectLab): boolean => lab.agentModules.length > 0 || lab.skills.length > 0 || lab.widgetDirs.length > 0;

/** the note the model reads before its first edit in a project that has a layer of its own. */
export function labNote(lab: ProjectLab): string {
    if (!hasLab(lab)) return '';
    const lines: string[] = ['this project has its own layer over marimo. read it before building anything, and act through it rather than beside it:'];
    for (const m of lab.agentModules) {
        const fns = m.functions.length > 0 ? ` (${m.functions.slice(0, 24).join(', ')}${m.functions.length > 24 ? ', …' : ''})` : '';
        lines.push(`  agent api: ${m.path}${m.importPath !== null ? `, import ${m.importPath}` : ''}${fns}`);
    }
    for (const s of lab.skills) lines.push(`  skill: ${s} (read it first; it states the conventions)`);
    for (const l of lab.launchers) lines.push(`  launcher: ${l}`);
    for (const w of lab.widgetDirs) lines.push(`  widgets: ${w}/ (custom views live here; extend them rather than drawing a new figure beside them)`);
    for (const n of lab.notebookDirs.slice(0, 4)) lines.push(`  notebooks: ${n.path}/ (${n.count})`);
    return lines.join('\n');
}
