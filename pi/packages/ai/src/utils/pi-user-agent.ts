import type * as NodeOs from "node:os";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// Keep runtime OS loading browser-safe. A top-level runtime import of node:os breaks browser/Vite builds.
const nodeOs = loadNodeOs();

/**
 * The product token this fork sends on requests it makes as itself.
 *
 * Providers that expect a specific client — Codex, Claude Code, Copilot — set
 * their own identity instead of this one, and must keep doing so: those are
 * wire formats, not branding.
 */
export const USER_AGENT_APP = "nekocode";

export function getPiUserAgent(): string {
	return nodeOs
		? `${USER_AGENT_APP} (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})`
		: `${USER_AGENT_APP} (browser)`;
}
