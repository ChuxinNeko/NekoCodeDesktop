import type { ThinkingLevel } from "./agent";

export interface FusionConfig {
	leadModelKey: string;
	leadThinkingLevel: ThinkingLevel;
	sidekickModelKey: string;
	sidekickThinkingLevel: ThinkingLevel;
	/** Opt-in: route between configured roles at compaction, at most once per task. */
	adaptiveRouting?: boolean;
}

const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function isFusionConfig(value: unknown): value is FusionConfig {
	if (!value || typeof value !== "object") return false;
	const config = value as FusionConfig;
	return typeof config.leadModelKey === "string" && !!config.leadModelKey &&
		typeof config.sidekickModelKey === "string" && !!config.sidekickModelKey &&
		levels.has(config.leadThinkingLevel) && levels.has(config.sidekickThinkingLevel) &&
		(config.adaptiveRouting === undefined || typeof config.adaptiveRouting === "boolean");
}
