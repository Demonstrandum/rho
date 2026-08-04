// /audit: invoke the auditor skill to review the last assistant prose output
// against the writer rules. modelled on ponytail's command-to-skill pattern.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
    pi.registerCommand('audit', {
        description: 'audit the last response against the writer rules',
        handler: async (args, ctx) => {
            const audience = args.trim();
            const prompt = audience
                ? `/skill:auditor audience: ${audience}`
                : '/skill:auditor';

            // pi.sendUserMessage is available at runtime (ponytail uses it)
            // but has no TypeScript declaration. cast through unknown.
            const send = (pi as unknown as { sendUserMessage(msg: string): void }).sendUserMessage;
            if (typeof send === 'function') {
                send.call(pi, prompt);
            } else {
                ctx.ui.notify('sendUserMessage not available; send the skill invocation manually', 'warning');
            }
        },
    });
}
