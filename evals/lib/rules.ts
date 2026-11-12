// the rules a response is reviewed against, read from system/ so the review
// always uses the live wording. numbered rules keep their own ids (8.(i),
// o2.(iii), p1.(iii)); the bullets of personal-rules.md, which have no
// numbers, get `<section>.<n>` (risky-actions.3).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fragment } from './intents';

export interface Rule {
    readonly id: string;
    readonly fragment: Fragment;
    readonly section: string;
    /** the first line, which carries the rule's name or its claim. */
    readonly title: string;
    readonly text: string;
}

const systemDir = join(import.meta.dir, '..', '..', 'system');

const NUMBERED = /^((?:[op])?\d+\.\([ivx]+\))\s+(.*)$/;

function numbered(fragment: Fragment, source: string): Rule[] {
    const rules: Rule[] = [];
    let section = '';
    let current: { id: string; lines: string[] } | null = null;
    const close = (): void => {
        if (!current) return;
        const text = current.lines.join('\n').trim();
        const title = (current.lines[0] ?? '').replace(/\*\*/g, '').trim();
        rules.push({ id: current.id, fragment, section, title, text });
        current = null;
    };
    for (const line of source.split('\n')) {
        if (line.startsWith('## ')) {
            close();
            section = line.slice(3).trim();
            continue;
        }
        const match = NUMBERED.exec(line);
        if (match) {
            close();
            current = { id: match[1]!, lines: [match[2]!] };
        } else if (current && !line.startsWith('#')) {
            current.lines.push(line);
        }
    }
    close();
    return rules;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function bullets(fragment: Fragment, source: string): Rule[] {
    const rules: Rule[] = [];
    let section = '';
    let n = 0;
    let current: string[] | null = null;
    const close = (): void => {
        if (!current) return;
        const text = current.join('\n').trim();
        rules.push({ id: `${slug(section)}.${n}`, fragment, section, title: current[0]!.trim(), text });
        current = null;
    };
    for (const line of source.split('\n')) {
        if (line.startsWith('## ')) {
            close();
            section = line.slice(3).trim();
            n = 0;
        } else if (line.startsWith('- ')) {
            close();
            n++;
            current = [line.slice(2)];
        } else if (current && /^\s+\S/.test(line)) {
            current.push(line.trim());
        } else if (current && line.trim() === '') {
            close();
        }
    }
    close();
    return rules;
}

export function loadRules(dir = systemDir): Rule[] {
    const read = (f: Fragment): string => readFileSync(join(dir, f), 'utf8');
    return [
        ...bullets('personal-rules.md', read('personal-rules.md')),
        ...numbered('writer-rules.md', read('writer-rules.md')),
        ...numbered('orthography.md', read('orthography.md')),
        ...numbered('prose-style.md', read('prose-style.md')),
    ];
}

/** the rules as one compact listing, for a judge prompt. */
export function ruleListing(rules: readonly Rule[]): string {
    return rules.map((r) => `[${r.id}] ${r.text.replace(/\n+/g, ' ')}`).join('\n');
}
