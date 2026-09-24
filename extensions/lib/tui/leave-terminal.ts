/**
 * Ending a pi process from inside an extension, with the terminal put back.
 *
 * `process.exit` runs no cleanup, so the terminal keeps raw mode, bracketed
 * paste and the kitty keyboard protocol, and the next keystrokes arrive as
 * escape sequences printed into the shell (`0;1:3u` and friends) with half a
 * prompt still on screen. `tui.stop` puts all of it back, and it is reached
 * the way pi's own external-editor handoff reaches it.
 *
 * Two extensions leave this way: /detach, and the interface that comes back
 * from another machine and is told to go out to the shell rather than draw the
 * local session again.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

/**
 * What pi says on the way out, plus the way back to a session that is still up.
 *
 * pi prints "To resume this session: pi --session <id>" from its own shutdown,
 * which does not run when an extension leaves by itself, so the line is
 * rebuilt here rather than lost. The id resumes the transcript in a new
 * process; the name attaches to the agent that is still running on it, which
 * is the difference detaching makes and the reason both are printed.
 */
export function resumeLines(ctx: ExtensionContext, name: string | undefined): readonly string[] {
    const id = ctx.sessionManager.getSessionId();
    const lines: string[] = [];
    if (id !== undefined && id !== '') lines.push(`To resume this session: pi --session ${id}`);
    if (name !== undefined && name !== '') lines.push(`Or attach it by name:   ${attachCommand(name)}`);
    return lines;
}

/**
 * The shell command that draws a session that is still running.
 *
 * pi's own command line, because rho registers the flag on it. Printing a path
 * to a script inside a checkout, to be run under bun, is neither short nor
 * something anybody would type twice.
 */
export function attachCommand(name: string): string {
    return `pi --attach ${name}`;
}

/**
 * Leave, without leaving the terminal in pi's mode.
 *
 * The wait exists because shutdown is deferred to the next idle moment, which
 * from a key handler has not always arrived: the interface stayed up while the
 * daemon waited for it, which is the one state a detach must not leave behind.
 * A shutdown that does land exits first and this never runs.
 */
export function leaveTerminal(ctx: ExtensionContext, after: number, farewell: readonly string[] = []): void {
    ctx.shutdown();
    const timer = setTimeout(() => {
        void ctx.ui
            .custom<void>((tui, _theme, _keys, done) => {
                tui.stop();
                done();
                return { render: () => [], handleInput: () => {}, invalidate: () => {} };
            })
            .finally(() => {
                // After the terminal is its own again, so the lines stay on
                // screen rather than being wiped by the restore, and in the
                // shape pi leaves behind on its own exit.
                for (const line of farewell) process.stdout.write(`${line}\n`);
                process.exit(0);
            });
    }, after);
    // A process that is on its way out anyway should not be held open by this
    // timer alone.
    timer.unref?.();
}
