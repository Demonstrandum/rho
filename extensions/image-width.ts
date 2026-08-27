// set the width pi renders inline images at, in terminal cells, from
// [images] width in rho.toml. pi does not clamp the value to the terminal, so a
// width above the window's column count makes an image overflow the screen;
// keep it under `tput cols`. persist it into the global settings, idempotently
// (same pattern as clear-on-shrink / silence-extra-usage-warning), since pi
// exposes no runtime setter for it.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ensureGlobalSetting } from './lib/settings-store';
import { config } from './lib/config';

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode !== 'tui') {
            return;
        }
        try {
            ensureGlobalSetting(['terminal', 'imageWidthCells'], config.images.width);
        } catch {
            // best effort: a settings write failure must never break startup.
        }
    });
}
