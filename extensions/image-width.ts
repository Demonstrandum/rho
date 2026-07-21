// widen pi's inline image rendering to 180 terminal cells. pi renders images
// (e.g. from fetch_content) at terminal.imageWidthCells wide; the default is
// narrow. persist the value once into the global settings, idempotently (same
// pattern as clear-on-shrink / silence-extra-usage-warning), since pi exposes
// no runtime setter for it.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ensureGlobalSetting } from './lib/settings-store';

const IMAGE_WIDTH_CELLS = 180;

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode !== 'tui') {
            return;
        }
        try {
            ensureGlobalSetting(['terminal', 'imageWidthCells'], IMAGE_WIDTH_CELLS);
        } catch {
            // best effort: a settings write failure must never break startup.
        }
    });
}
