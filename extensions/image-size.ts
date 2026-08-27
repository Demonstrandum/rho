// cap the height of an inline image at a share of the terminal height.
//
// pi passes a width to pi-tui's Image and lets the height follow the aspect
// ratio: a 640x537 png at the default 60 cells becomes 26 rows, which does not
// fit a 24-row window. the rows are reserved, so the transcript scrolls while
// the image stays painted where the terminal put it, and the text that follows
// is drawn over it.
//
// Image already accepts maxHeightCells, and honouring it shrinks the width to
// match, so the fix is to supply one. terminal.imageWidthCells (see
// image-width.ts) sets the width; this sets the ceiling that the window itself
// imposes, which no fixed width can express.
//
// the patch reads the live terminal height at render time, so a resize needs no
// state of its own. [images] max-height-fraction = 1 disables it.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Image } from '@earendil-works/pi-tui';
import { config } from './lib/config';

/** the fields of Image this patch reads. pi-tui declares them private. */
interface ImageInternals {
    readonly options: { maxWidthCells?: number; maxHeightCells?: number };
    invalidate(): void;
}

type Render = (this: Image, width: number) => string[];

/** rows an image may occupy, from the current window height. */
function heightCap(): number {
    const rows = process.stdout.rows;
    if (!rows || rows <= 0) return Number.POSITIVE_INFINITY;
    // three rows is the smallest image worth drawing; below that the fallback
    // text is more use than a strip of pixels.
    return Math.max(3, Math.floor(rows * config.images.maxHeightFraction));
}

let patched = false;

function patch(): void {
    if (patched || config.images.maxHeightFraction >= 1) return;
    patched = true;

    const original = Image.prototype.render as Render;
    Image.prototype.render = function (this: Image, width: number): string[] {
        try {
            const internals = this as unknown as ImageInternals;
            const wanted = Math.min(internals.options.maxHeightCells ?? Number.POSITIVE_INFINITY, heightCap());
            if (Number.isFinite(wanted) && internals.options.maxHeightCells !== wanted) {
                internals.options.maxHeightCells = wanted;
                // the render cache is keyed on width alone, so a changed cap
                // (a resize, or the first render) needs the cache dropped.
                internals.invalidate();
            }
        } catch {
            // a failure here must not cost the image; fall through to pi's own
            // sizing.
        }
        return original.call(this, width);
    } as Render;
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode !== 'tui') return;
        patch();
    });
}
