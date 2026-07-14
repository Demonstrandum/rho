import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const rulesPath = join(dirname(fileURLToPath(import.meta.url)), "personal-rules.md");

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const rules = readFileSync(rulesPath, "utf8").trim();
		return { systemPrompt: `${event.systemPrompt}\n\n${rules}` };
	});
}
