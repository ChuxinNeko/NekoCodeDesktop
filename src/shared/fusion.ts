import type { ThinkingLevel } from "./agent";

/** Parent decisions stay on Lead; helpers default to Sidekick and may escalate. */
export interface FusionConfig {
	/** Persistent team workspace conversation, independent of the selected desktop chat. */
	teamRoomId?: string;
	/** Public configurations use the shared engine; old literals support internal legacy tests. */
	orchestration?: "engine" | "parallel" | "inline";
	/**
	 * Engine strategy. "delegate" (default): Lead briefs, Sidekick implements and tests,
	 * Lead reviews the diff and accepts, requests fixes, or takes over. "parallel": the
	 * reference plan → parallel lanes → Lead synthesis engine. "team": the AI team from
	 * Settings → Team; the admin answers or assigns work to members (see docs/team.md).
	 */
	strategy?: "delegate" | "parallel" | "team";
	/** Shared engine defaults to 24 messages per lane. */
	contextMessageLimit?: number;
	budget?: { maxTurns?: number; maxTokens?: number; timeoutMs?: number };
	workerProfiles?: Array<{ name: string; instructions: string; description?: string; model?: string; tools?: string[] }>;
	leadModelKey: string;
	leadThinkingLevel: ThinkingLevel;
	sidekickModelKey: string;
	sidekickThinkingLevel: ThinkingLevel;
	/** Reference routing after lane compaction, based on recorded Sidekick failures. */
	adaptiveRouting?: boolean;
	/**
	 * Legacy orchestration only. Shared engine preserves the reference failure
	 * policy and does not replay requests on the alternate model.
	 */
	failover?: boolean;
}

const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function isFusionConfig(value: unknown): value is FusionConfig {
	if (!value || typeof value !== "object") return false;
	const config = value as FusionConfig;
	return typeof config.leadModelKey === "string" && !!config.leadModelKey &&
		(config.teamRoomId === undefined || (typeof config.teamRoomId === "string" && !!config.teamRoomId)) &&
		typeof config.sidekickModelKey === "string" && !!config.sidekickModelKey &&
		levels.has(config.leadThinkingLevel) && levels.has(config.sidekickThinkingLevel) &&
		(config.adaptiveRouting === undefined || typeof config.adaptiveRouting === "boolean") &&
		(config.orchestration === undefined || ["engine", "parallel", "inline"].includes(config.orchestration)) &&
		(config.strategy === undefined || ["delegate", "parallel", "team"].includes(config.strategy)) &&
		(config.contextMessageLimit === undefined || (Number.isInteger(config.contextMessageLimit) && config.contextMessageLimit > 0)) &&
		(config.budget === undefined || (!!config.budget && typeof config.budget === "object" &&
			Object.entries(config.budget).every(([key, limit]) => ["maxTurns", "maxTokens", "timeoutMs"].includes(key) &&
				(limit === undefined || (typeof limit === "number" && Number.isInteger(limit) && limit > 0))))) &&
		(config.workerProfiles === undefined || (Array.isArray(config.workerProfiles) && config.workerProfiles.every(profile =>
			profile && typeof profile.name === "string" && !!profile.name.trim() && typeof profile.instructions === "string" &&
			(profile.description === undefined || typeof profile.description === "string") &&
			(profile.model === undefined || (typeof profile.model === "string" && !!profile.model.trim())) &&
			(profile.tools === undefined || (Array.isArray(profile.tools) && profile.tools.every(tool => typeof tool === "string")))))) &&
		(config.failover === undefined || typeof config.failover === "boolean");
}
