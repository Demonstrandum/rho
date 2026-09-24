// replace pi's built-in startup block (logo + key-hint wall + the "[Prompts]"
// style bracketed resource listing) with a compact, bold-inline header topped
// by an animated pi wordmark.
//
// pi renders its own block in core and it is not reformattable in place, so the
// approach is: (1) persist quietStartup=true to suppress the built-in block,
// (2) draw our own via ctx.ui.setHeader().
//
// the header runs a ~2s one-shot intro on session start: a quick fade-in (or,
// 1/3 of the time, a block-by-block build-up), then a diagonal down-right
// shimmer, then the "pi vX" label types out with a blinking cursor. it drives
// its own repaints with a timer + tui.requestRender() and clears the timer once
// settled, so nothing animates after the header scrolls out of view. render() is
// a pure function of elapsed time, so resizes/repaints stay consistent.
//
// resource data comes from the public API: pi.getCommands() distinguishes
// prompts / skills / extension commands by `source`, and ctx.ui.getAllThemes()
// lists themes. there is no API to enumerate the loaded extension *files*, so
// there is no "Extensions" section; the extension-provided slash commands show
// under "commands" instead.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { ensureGlobalSetting } from './lib/core/settings-store';
import { config } from './lib/core/config';
import { createIntro } from './lib/chrome/intro-card';
import { headerLines } from './lib/chrome/startup-header';
import { FRAME_MS } from './lib/chrome/pi-logo';

export default function (pi: ExtensionAPI) {
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode !== 'tui') {
            return;
        }

        try {
            ensureGlobalSetting(['quietStartup'], true);
        } catch {
            // best effort: a settings write failure must never break startup.
        }

        // one playing of the intro, picked from [startup] in rho.toml.
        const intro = createIntro();

        ctx.ui.setHeader((tui, theme) => {
            const start = Date.now();
            const timer = config.startup.animate
                ? setInterval(() => {
                    if (Date.now() - start >= intro.settleAt) clearInterval(timer);
                    tui.requestRender();
                }, FRAME_MS)
                : undefined;

            return {
                dispose() {
                    if (timer) clearInterval(timer);
                },
                invalidate() {},
                render(width: number): string[] {
                    const lines = headerLines({
                        intro,
                        theme,
                        elapsed: Date.now() - start,
                        sessionId: ctx.sessionManager.getSessionId(),
                        commands: pi.getCommands(),
                        themes: ctx.ui
                            .getAllThemes()
                            .filter((entry) => entry.path !== undefined)
                            .map((entry) => entry.name),
                    });

                    return ['', ...lines.map((line) => truncateToWidth(line, width, theme.fg('dim', '...'))), ''];
                },
            };
        });
    });
}
