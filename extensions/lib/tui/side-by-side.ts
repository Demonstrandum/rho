// two columns in one component: a list on the left, what it is choosing between
// on the right.
//
// pi's components each render to an array of lines for a given width, and a
// Container stacks them, so a picker that shows a choice beside its effect has
// to place the two itself. this does that placement and nothing else: the left
// component is rendered at a fixed width, padded to it, and joined to the right
// lines with a rule between them.
//
// below `minWidth` the columns are stacked instead, since two narrow columns
// are less readable than one of either.

import type { Component } from '@earendil-works/pi-tui';
import { spliceVisible, visibleWidth } from '../core/text';

/** clip a styled line to `width` columns, keeping its escape sequences. */
export function clip(line: string, width: number): string {
    const shown = visibleWidth(line);
    if (width <= 0) return '';
    return shown <= width ? line : spliceVisible(line, width, shown, '');
}

/** pad a styled line out to `width` columns. */
export function pad(line: string, width: number): string {
    const room = width - visibleWidth(line);
    return room > 0 ? line + ' '.repeat(room) : line;
}

export interface SideBySideOptions {
    /** columns the left component is rendered at. */
    readonly leftWidth: number;
    /** what separates the columns, styled, and how wide it prints. */
    readonly rule: () => string;
    readonly ruleWidth: number;
    /** under this total width the columns are stacked, right under left. */
    readonly minWidth: number;
    /** blank lines between the columns when they are stacked. */
    readonly stackGap?: number;
}

export class SideBySide implements Component {
    constructor(
        private readonly left: Component,
        /** the right column, which is given the columns it has to fill. */
        private readonly right: (width: number) => string[],
        private readonly options: SideBySideOptions,
    ) {}

    render(width: number): string[] {
        if (width < this.options.minWidth) {
            const gap = Array.from({ length: this.options.stackGap ?? 1 }, () => '');
            return [...this.left.render(width), ...gap, ...this.right(width)];
        }
        const { leftWidth, ruleWidth } = this.options;
        const rule = this.options.rule();
        const rows = this.left.render(leftWidth);
        const lines = this.right(Math.max(0, width - leftWidth - ruleWidth)).map((line) =>
            clip(line, Math.max(0, width - leftWidth - ruleWidth)),
        );
        const height = Math.max(rows.length, lines.length);
        return Array.from({ length: height }, (_, i) => `${pad(rows[i] ?? '', leftWidth)}${rule}${lines[i] ?? ''}`);
    }

    invalidate(): void {
        this.left.invalidate?.();
    }
}
