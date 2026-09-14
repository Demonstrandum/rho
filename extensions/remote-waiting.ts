/**
 * Say when a remote turn has gone quiet.
 *
 * Only in the client that draws a session running on another machine: locally
 * a stalled request is the local pi's business, and it has its own indicator.
 * Here the difference between a model thinking and a request that will never
 * be answered is invisible, because both are an absence of events.
 *
 * The client raises pi's extension events for the far side's turns, so this
 * reads the same events any extension does.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SILENCE_MS, quiet, waitingLine } from './lib/waiting';

const WIDGET = 'remote-waiting';
const TICK_MS = 1000;

/** the marker the remote client publishes: the session is somewhere else. */
const elsewhere = (): boolean =>
    (globalThis as { __rho_environment?: { alive?: boolean } }).__rho_environment?.alive === true;

export default function (pi: ExtensionAPI) {
    if (!elsewhere()) return;

    let ctx: ExtensionContext | undefined;
    let streaming = false;
    let lastEventAt: number | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let shown = false;

    const clear = (): void => {
        if (shown && ctx !== undefined) ctx.ui.setWidget(WIDGET, undefined);
        shown = false;
    };

    const tick = (): void => {
        if (ctx === undefined) return;
        const state = quiet(streaming, lastEventAt, Date.now());
        if (state.kind !== 'silent') {
            clear();
            return;
        }
        ctx.ui.setWidget(WIDGET, [ctx.ui.theme.fg('dim', waitingLine(state.silentMs))]);
        shown = true;
    };

    const stopTimer = (): void => {
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
    };

    const heard = (next: ExtensionContext): void => {
        ctx = next;
        lastEventAt = Date.now();
        clear();
    };

    const started = (next: ExtensionContext): void => {
        heard(next);
        streaming = true;
        if (timer === undefined) timer = setInterval(tick, TICK_MS);
    };

    const ended = (next: ExtensionContext): void => {
        ctx = next;
        streaming = false;
        lastEventAt = null;
        stopTimer();
        clear();
    };

    pi.on('agent_start', async (_event, next) => started(next));
    pi.on('turn_start', async (_event, next) => started(next));
    pi.on('message_start', async (_event, next) => heard(next));
    pi.on('message_update', async (_event, next) => heard(next));
    pi.on('message_end', async (_event, next) => heard(next));
    pi.on('tool_execution_start', async (_event, next) => heard(next));
    pi.on('tool_execution_end', async (_event, next) => heard(next));
    pi.on('turn_end', async (_event, next) => heard(next));
    pi.on('agent_end', async (_event, next) => ended(next));
}

export { SILENCE_MS };
