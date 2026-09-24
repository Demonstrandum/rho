// rewrites the assembled system prompt into the house style before the session
// starts, so that pi's own head and the tool snippets the bundled packages
// contribute read the way the rest of the prompt does.
//
// the transform is extensions/lib/disenshittification.ts. every markdown file
// in rho is a fixed point of it (tests/disenshittification.test.ts holds that),
// so what it changes here is pi's text and third-party text, nothing of ours.
//
// ordering: pi chains before_agent_start handlers in extension load order,
// which is alphabetical, so prompt-defingerprint.ts runs first and its
// replacements land before this reads the prompt. those replacements are
// written in lower case for the case where that order ever changes.
//
// the anthropic block ("You are Claude Code, ...") is not in this text. the
// transport adds it as a separate system block at request time, it is what
// keeps an oauth request on plan billing, and nothing here may rewrite it.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { config } from './lib/core/config';
// tools/unshitty.ts sets this to capture the prompt as it stands before the
// rewrite, so it can show the diff the rewrite makes.
const DISABLE = 'RHO_DISENSHITTIFY_OFF';
import { disenshittifyMarkdown } from './lib/prose/disenshittification';

export default function (pi: ExtensionAPI) {
    pi.on('before_agent_start', async (event) => {
        if (!config.prompt.disenshittify || process.env[DISABLE] === '1') return;
        const systemPrompt = disenshittifyMarkdown(event.systemPrompt);
        if (systemPrompt === event.systemPrompt) return;
        return { systemPrompt };
    });
}
