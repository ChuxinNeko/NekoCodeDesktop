import { delimiter } from "node:path";
import type { BashSpawnContext, ToolsOptions } from "@earendil-works/pi-coding-agent";

function isBunNodeShim(entry: string): boolean {
	const normalized = entry.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
	return /(?:^|[\\/])bun-node-[^\\/]+$/i.test(normalized);
}

export function sanitizeNekoShellEnvironment(context: BashSpawnContext): BashSpawnContext {
	const env = { ...context.env };
	delete env.NODE_ENV;
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() !== "path" || typeof env[key] !== "string") continue;
		env[key] = env[key]!.split(delimiter).filter((entry) => !isBunNodeShim(entry)).join(delimiter);
	}
	return { ...context, env };
}

export const NEKOCODE_TOOL_OPTIONS: ToolsOptions = {
	bash: { spawnHook: sanitizeNekoShellEnvironment },
	powershell: { spawnHook: sanitizeNekoShellEnvironment },
};
