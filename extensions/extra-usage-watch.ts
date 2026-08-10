import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// detect when anthropic routes requests to extra-usage ("overage") billing
// instead of plan claims, and warn once per session. detection reads the
// unified rate-limit headers on every anthropic response; no reliance on
// errors, so it catches silent metering even with available credits.
//
// replaces the blunt built-in startup warning (suppressed by
// silence-extra-usage-warning.ts) with an evidence-based one.

const PLAN_CLAIMS = new Set(['five_hour', 'seven_day']);
const HEADER = 'anthropic-ratelimit-unified-representative-claim';
const OVERAGE_UTIL = 'anthropic-ratelimit-unified-overage-utilization';

export default function (pi: ExtensionAPI) {
    let lastOverageUtil = -1;
    let warnedThisSession = false;

    pi.on('after_provider_response', (event, ctx) => {
        const claim = event.headers[HEADER];
        if (!claim) return; // not an anthropic unified-limiter response

        const overageUtil = parseFloat(event.headers[OVERAGE_UTIL] ?? '');

        const onPlan = PLAN_CLAIMS.has(claim);

        // 429 while NOT on a plan claim: spend-limit hit on the overage pool
        // (skip genuine rate limits, which still show a plan claim)
        if (event.status === 429 && !onPlan && !warnedThisSession) {
            ctx.ui.notify(
                "anthropic routed this request to extra-usage billing (spend cap hit). the prompt-defingerprint extension may need updated rules.",
                'warning',
            );
            ctx.ui.setStatus('extra-usage', 'extra-usage: active');
            warnedThisSession = true;
            return;
        }

        // representative claim is not a plan window: overage-billed 200
        if (!onPlan && !warnedThisSession) {
            ctx.ui.notify(
                `anthropic billed this request to "${claim}" (not the plan). extra-usage metering is active.`,
                'warning',
            );
            ctx.ui.setStatus('extra-usage', 'extra-usage: active');
            warnedThisSession = true;
            return;
        }

        // overage utilization ticking up: credits being spent on extra usage
        if (!isNaN(overageUtil) && lastOverageUtil >= 0 && overageUtil > lastOverageUtil && !warnedThisSession) {
            ctx.ui.notify(
                "extra-usage utilization is increasing: requests may be partially billed to extra usage.",
                'warning',
            );
            ctx.ui.setStatus('extra-usage', 'extra-usage: active');
            warnedThisSession = true;
        }
        if (!isNaN(overageUtil)) lastOverageUtil = overageUtil;

        // clear status and allow re-warn if back on plan claims
        if (onPlan && warnedThisSession && event.status === 200) {
            ctx.ui.setStatus('extra-usage', undefined);
            warnedThisSession = false;
        }
    });
}
