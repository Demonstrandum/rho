// silence pi's "Anthropic subscription auth is active ... billed per token"
// startup warning by persisting warnings.anthropicExtraUsage=false into the
// global settings once. i run pi with subscription auth knowingly and do not
// want the notice every session. pi exposes no setter for this, so the durable
// fix is a one-time idempotent settings write (same pattern as clear-on-shrink).

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ensureGlobalSetting } from './lib/settings-store';

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode !== 'tui') {
            return;
        }
        try {
            ensureGlobalSetting(['warnings', 'anthropicExtraUsage'], false);
        } catch {
            // best effort: a settings write failure must never break startup.
        }
    });
}
