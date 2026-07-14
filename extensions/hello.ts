// starter extension: a custom tool plus a /slash command. replace with your own.

import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

const helloTool = defineTool({
    name: 'hello',
    label: 'hello',
    description: "a simple greeting tool",
    parameters: Type.Object({
        name: Type.String({ description: "name to greet" }),
    }),
    async execute(_toolCallId, params) {
        return {
            content: [{ type: 'text', text: `hello, ${params.name}!` }],
            details: { greeted: params.name },
        };
    },
});

export default function (pi: ExtensionAPI) {
    pi.registerTool(helloTool);

    pi.registerCommand('rho', {
        description: "rho dotfiles: show a hello from your own package",
        handler: async (_args, ctx) => {
            ctx.ui.notify("rho dotfiles loaded", 'info');
        },
    });
}
