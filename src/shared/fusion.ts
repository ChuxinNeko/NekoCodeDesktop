import type { ThinkingLevel } from "./agent";

/** Parent decisions stay on Lead; helpers default to Sidekick and may escalate. */
export interface FusionConfig {
	leadModelKey: string;
	leadThinkingLevel: ThinkingLevel;
	sidekickModelKey: string;
	sidekickThinkingLevel: ThinkingLevel;
	/** Helper routing at task start and natural compaction boundaries. Defaults to true. */
	adaptiveRouting?: boolean;
	/**
	 * High availability: when one model's endpoint fails (auth, quota, 5xx,
	 * network, stall) before producing output, the same request is replayed on
	 * the other Fusion model. Defaults to true.
	 */
	failover?: boolean;
}

const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function isFusionConfig(value: unknown): value is FusionConfig {
	if (!value || typeof value !== "object") return false;
	const config = value as FusionConfig;
	return typeof config.leadModelKey === "string" && !!config.leadModelKey &&
		typeof config.sidekickModelKey === "string" && !!config.sidekickModelKey &&
		levels.has(config.leadThinkingLevel) && levels.has(config.sidekickThinkingLevel) &&
		(config.adaptiveRouting === undefined || typeof config.adaptiveRouting === "boolean") &&
		(config.failover === undefined || typeof config.failover === "boolean");
}
