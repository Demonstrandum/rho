// a scrolling read-only view of text, for a ctx.ui.custom() component.
//
// pi-tui ships ScrollView, but it takes its viewport from a layout pass that
// only a fullscreen (viewport) TUI runs, and a session in regular mode has no
// such pass. this keeps the window itself: a wrapped copy of the text cached
// per width, a scroll offset into it, and a render of one screenful.
//
// the text is plain. wrapping happens at render time against the width given,
// so a resize reflows without the caller knowing.

import type { Theme } from '@earendil-works/pi-coding-agent';
import { type Component, type KeyId, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export interface PagerContent {
    readonly title: string;
    readonly lines: readonly string[];
}

const SCROLL_KEYS = {
    up: ['up', 'ctrl+p'],
    down: ['down', 'ctrl+n'],
    pageUp: ['pageUp'],
    pageDown: ['pageDown'],
    start: ['home'],
    end: ['end'],
} as const satisfies Record<string, readonly KeyId[]>;

/** how many rows below the terminal height the body is kept, for chrome. */
const CHROME_ROWS = 8;
const MIN_BODY_ROWS = 4;

export class Pager implements Component {
    private content: PagerContent;
    private scroll = 0;
    private wrapped: readonly string[] = [];
    private wrappedAt = -1;

    constructor(
        content: PagerContent,
        private readonly theme: Theme,
        private readonly rows: () => number,
        private readonly hints: readonly string[],
    ) {
        this.content = content;
    }

    setContent(content: PagerContent): void {
        this.content = content;
        this.scroll = 0;
        this.invalidate();
    }

    invalidate(): void {
        this.wrappedAt = -1;
    }

    private body(width: number): readonly string[] {
        if (this.wrappedAt !== width) {
            const out: string[] = [];
            for (const line of this.content.lines) {
                if (line === '') {
                    out.push('');
                    continue;
                }
                out.push(...wrapTextWithAnsi(line, Math.max(1, width)));
            }
            this.wrapped = out;
            this.wrappedAt = width;
        }
        return this.wrapped;
    }

    private viewport(): number {
        return Math.max(MIN_BODY_ROWS, this.rows() - CHROME_ROWS);
    }

    /** clamp after a resize or a content change, so the view never sits past the end. */
    private clamp(total: number): void {
        const last = Math.max(0, total - this.viewport());
        if (this.scroll > last) this.scroll = last;
        if (this.scroll < 0) this.scroll = 0;
    }

    render(width: number): string[] {
        const lines = this.body(width);
        const height = this.viewport();
        this.clamp(lines.length);
        const shown = lines.slice(this.scroll, this.scroll + height);
        const end = Math.min(lines.length, this.scroll + height);
        const position = lines.length === 0 ? 'empty' : `${this.scroll + 1}-${end} of ${lines.length}`;
        const header = truncateToWidth(
            `${this.theme.bold(this.content.title)}  ${this.theme.fg('dim', position)}`,
            width,
        );
        return [
            this.theme.fg('accent', header),
            '',
            ...shown.map((line) => truncateToWidth(line, width)),
            '',
            truncateToWidth(this.theme.fg('dim', this.hints.join(', ')), width),
        ];
    }

    /** true when the key moved the view, so the caller knows it was consumed. */
    handleInput(data: string): boolean {
        const by = (lines: number): boolean => {
            const before = this.scroll;
            this.scroll = Math.max(0, this.scroll + lines);
            return this.scroll !== before;
        };
        const page = Math.max(1, this.viewport() - 1);
        if (SCROLL_KEYS.up.some((key) => matchesKey(data, key))) return by(-1);
        if (SCROLL_KEYS.down.some((key) => matchesKey(data, key))) return by(1);
        if (SCROLL_KEYS.pageUp.some((key) => matchesKey(data, key))) return by(-page);
        if (SCROLL_KEYS.pageDown.some((key) => matchesKey(data, key)) || data === ' ') return by(page);
        if (SCROLL_KEYS.start.some((key) => matchesKey(data, key))) return by(-this.wrapped.length);
        if (SCROLL_KEYS.end.some((key) => matchesKey(data, key))) return by(this.wrapped.length);
        return false;
    }
}
