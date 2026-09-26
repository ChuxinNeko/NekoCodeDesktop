import { delimiter } from "node:path";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

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

/**
 * Asks PowerShell 7 for plain text. It colours table headers and error
 * messages with ANSI escapes even when its output is a pipe; the escape byte
 * is stripped on the way to the transcript, which leaves `[32;1m` littered
 * through the result — for the user to read and the model to reason about.
 * `TERM=dumb` switches off every kind (tables and errors alike, and for the
 * programs it starts); `PlainText` rendering covers a pwsh that ignores TERM.
 * Windows PowerShell 5.1 has no `$PSStyle` and never colours, so the guard
 * makes the line a no-op there.
 */
const POWERSHELL_PLAIN_TEXT = "if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }\n";

export function sanitizeNekoPowerShellEnvironment(context: BashSpawnContext): BashSpawnContext {
	const sanitized = sanitizeNekoShellEnvironment(context);
	const env = { ...sanitized.env };
	const term = Object.keys(env).find((key) => key.toUpperCase() === "TERM");
	if (term) delete env[term];
	env.TERM = "dumb";
	return { ...sanitized, env, command: `${POWERSHELL_PLAIN_TEXT}${sanitized.command}` };
}
