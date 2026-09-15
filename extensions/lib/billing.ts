// which pool anthropic billed a response to, and what the responses it billed
// outside the plan have cost.
//
// the spend on the footer is computed from token counts at api list prices,
// and on a subscription nobody pays that: the plan does. showing it as the
// session's cost reads as a bill that is not owed. what is owed is the part
// anthropic metered to extra usage, which the unified rate-limit headers name
// on every response: a representative claim of `five_hour` or `seven_day` is a
// plan window, anything else is the overage pool.
//
// the headers arrive before the stream is read, and the token counts arrive
// with the finished message, so the mode is recorded first and the cost of the
// next assistant message is attributed to it. a resumed session starts its
// charged total at zero, since the headers of the earlier turns are gone; the
// api-price total is recomputed from the transcript and is unaffected.
//
// the state lives on globalThis so that /reload, which replaces both this
// module and its readers, does not leave two copies of it.

import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export type BillingMode =
    /** billed to a plan window: the subscription covers it */
    | 'plan'
    /** billed outside the plan: metered against extra usage */
    | 'extra-usage'
    /** no anthropic unified-limiter headers seen yet */
    | 'unknown';

export interface Billing {
    mode: BillingMode;
    /** dollars of api-price spend on responses billed outside the plan */
    charged: number;
}

export const CLAIM_HEADER = 'anthropic-ratelimit-unified-representative-claim';

const PLAN_CLAIMS: ReadonlySet<string> = new Set(['five_hour', 'seven_day']);

export const isPlanClaim = (claim: string): boolean => PLAN_CLAIMS.has(claim);

const STATE = '__rho_billing';

function state(): Billing {
    const shared = globalThis as typeof globalThis & { [STATE]?: Billing };
    return (shared[STATE] ??= { mode: 'unknown', charged: 0 });
}

export function billing(): Readonly<Billing> {
    return state();
}

export function trackBilling(pi: ExtensionAPI): void {
    pi.on('after_provider_response', (event) => {
        const claim = event.headers[CLAIM_HEADER];
        if (!claim) return; // not an anthropic unified-limiter response
        state().mode = isPlanClaim(claim) ? 'plan' : 'extra-usage';
    });

    pi.on('message_end', (event) => {
        if (event.message.role !== 'assistant') return;
        const current = state();
        if (current.mode !== 'extra-usage') return;
        current.charged += (event.message as AssistantMessage).usage.cost.total;
    });
}
