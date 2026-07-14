import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// edit these to change the working indicator.
const MESSAGE = "working";
const FRAMES = ['|', '/', '-', '\\'];
const INTERVAL_MS = 100;

function apply(ctx: ExtensionContext): void {
    ctx.ui.setWorkingMessage(ctx.ui.theme.fg('accent', MESSAGE));
    ctx.ui.setWorkingIndicator({
        frames: FRAMES.map((frame) => ctx.ui.theme.fg('accent', frame)),
        intervalMs: INTERVAL_MS,
    });
}

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        apply(ctx);
    });
}
