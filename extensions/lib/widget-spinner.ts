// a spinner for model calls an extension makes outside an agent turn.
//
// ctx.modelRegistry only exposes complete(), not stream(), to extensions (see
// model-registry.d.ts), so there is no sanctioned way to show such a call's
// tokens as they generate. this animates instead, so the wait is visibly alive
// rather than a static status line: a spinner frame plus elapsed time, written
// as a widget. setWorkingMessage and setWorkingIndicator are the wrong surface,
// since the docs tie both to an active agent turn, and neither a command
// handler nor a settled session is one.
//
// two callers hold the same wait: /audit reviewing a reply, and the goal loop
// judging its condition.
//
// in a subdirectory so extension auto-discovery (top-level *.ts only) does not
// load it as an extension.
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { duration as formatDuration } from './text';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 90;

/** what the spinner needs from a ctx: both extension contexts satisfy it. */
export type SpinnerContext = { readonly ui: Pick<ExtensionContext['ui'], 'setWidget' | 'theme'>; readonly hasUI?: boolean };

/**
 * run `work` with an animated widget under `key`, and take the widget down
 * however the work ends. with no UI (print or json mode) the work still runs
 * and nothing is drawn.
 */
export async function withSpinner<T>(
    ctx: SpinnerContext,
    key: string,
    label: string,
    work: () => Promise<T>,
): Promise<T> {
    if (ctx.hasUI === false) return work();

    const start = Date.now();
    let frame = 0;
    const tick = (): void => {
        const glyph = ctx.ui.theme.fg('accent', FRAMES[frame % FRAMES.length]);
        const text = ctx.ui.theme.fg('dim', `${label} ${formatDuration(Date.now() - start)}`);
        ctx.ui.setWidget(key, [`${glyph} ${text}`]);
        frame++;
    };
    tick();
    const timer = setInterval(tick, INTERVAL_MS);
    try {
        return await work();
    } finally {
        clearInterval(timer);
        ctx.ui.setWidget(key, undefined);
    }
}
