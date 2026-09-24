// where the working indicator is drawn, and what the rest of rho needs to know
// about it so no render patch paints over it.
//
// pi 0.85 moved the indicator (the spinner glyph and the working message) out of
// the status container below the input field and into the field's top border,
// drawn by CustomEditor.renderTopBorder. the choice is per editor instance:
// interactive-mode reads `embedWorkingStatus` through isWorkingStatusEditor
// before every show, and the default editor is constructed with it set.
//
// `[spinner] placement` picks between the two surfaces:
//
//   dock    the row below the field, on its own line, where pi drew it before
//           0.85 and where rho's default leaves it. the flag is cleared, the
//           indicator goes back to the status container, and the edge is rho's
//           to draw whole.
//   border  pi's arrangement. input-field.ts cuts the rendered status into its
//           half-block edge rather than replacing the row, which is what made
//           the spinner disappear when 0.85 landed.
//
// the flag is set from setWorkingStatusIndicator rather than at construction,
// because the editor is built in interactive-mode's constructor and an
// extension cannot be sure it loaded first. interactive-mode's
// setEditorWorkingStatusIndicator calls that method on the default editor
// before it consults isWorkingStatusEditor, so the value is always current by
// the time it is read, whatever order things loaded in.

import { CustomEditor } from '@earendil-works/pi-coding-agent';
// the column-aware measure, not lib/text's: a spinner glyph out of the chinese
// set prints two columns, and counting it as one leaves the row a column too
// long, which wraps and takes the layout with it.
import { visibleWidth } from '@earendil-works/pi-tui';
import { spliceVisible } from '../core/text';
import { RESET } from '../core/utils';
import { config } from '../core/config';

export type SpinnerPlacement = 'border' | 'dock';

export const placement: SpinnerPlacement = config.spinner.placement;

/** how far in from the left edge the status sits, and the space either side. */
const INSET = 2;
const MARGIN = 2;

/**
 * what pi's WorkingStatusIndicator offers a border. neither this nor the two
 * fields below are in the package's published types (`embedWorkingStatus` is
 * declared readonly, `workingStatusIndicator` private), so the runtime shape is
 * named here and the casts are confined to this file.
 */
interface BorderStatus {
    renderInBorder(width: number): string;
    renderSpinnerInBorder(width: number): string;
}

interface WorkingStatusEditor {
    embedWorkingStatus: boolean;
    workingStatusIndicator?: BorderStatus;
}

function surface(editor: unknown): WorkingStatusEditor {
    return editor as WorkingStatusEditor;
}

let installed = false;

/** hold the editor to the configured placement, from now on. */
export function installPlacement(): void {
    if (installed) return;
    installed = true;

    const embed = placement === 'border';
    const original = CustomEditor.prototype.setWorkingStatusIndicator;
    CustomEditor.prototype.setWorkingStatusIndicator = function (
        this: CustomEditor,
        indicator: Parameters<typeof original>[0],
    ): void {
        surface(this).embedWorkingStatus = embed;
        original.call(this, indicator);
    };
}

/**
 * the status this editor would cut into its top border, rendered for a row of
 * `width`, or undefined when there is nothing to draw there. the result is
 * always narrow enough for cutInto to place it.
 *
 * the editor decides, not the configuration: installPlacement has already put
 * the choice on the instance, and an editor holding no indicator has nothing to
 * cut in whatever the file says.
 */
export function borderStatus(editor: unknown, width: number): string | undefined {
    const held = surface(editor);
    const indicator = held.workingStatusIndicator;
    if (indicator === undefined || !held.embedWorkingStatus) return undefined;

    const room = width - INSET - MARGIN;
    if (room < 1) return undefined;

    // pi keeps a cell of border to the right of the message; below that it
    // falls back to the spinner alone, and so does this.
    const message = indicator.renderInBorder(Math.max(1, width - 5));
    if (visibleWidth(message) > 0 && visibleWidth(message) <= room) return message;

    const spinner = indicator.renderSpinnerInBorder(room);
    return visibleWidth(spinner) > 0 ? spinner : undefined;
}

/**
 * place `status` in `row` where pi places it in a border: `INSET` cells in,
 * with a space either side. the cells it covers are replaced rather than
 * pushed along, so the row keeps its visible width, and the escapes around
 * them stay where they were.
 *
 * `row` is a border of single-column cells, which is what lets a count of
 * columns index it.
 */
export function cutInto(row: string, status: string, width: number): string {
    const statusWidth = visibleWidth(status);
    const covered = statusWidth + MARGIN;
    if (statusWidth === 0 || INSET + covered > width) return row;
    return spliceVisible(row, INSET, INSET + covered, ` ${status}${RESET} `);
}
