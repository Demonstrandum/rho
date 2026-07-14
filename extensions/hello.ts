/**
 * hello — starter extension for the rho pi package.
 *
 * Demonstrates the two most common extension surfaces:
 *   - a custom tool the model can call
 *   - a custom /slash command for you
 *
 * Delete or rename this once you have your own.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			details: { greeted: params.name },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(helloTool);

	pi.registerCommand("rho", {
		description: "rho dotfiles: show a hello from your own package",
		handler: async (_args, ctx) => {
			ctx.ui.notify("rho dotfiles loaded 👋", "info");
		},
	});
}
