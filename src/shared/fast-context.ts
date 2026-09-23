import type { ThinkingLevel } from "./agent";

export interface FastContextConfig {
	modelKey: string | null;
	thinkingLevel: ThinkingLevel;
}

export const DEFAULT_FAST_CONTEXT_CONFIG: FastContextConfig = {
	modelKey: null,
	thinkingLevel: "low",
};

const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function isFastContextConfig(value: unknown): value is FastContextConfig {
	if (!value || typeof value !== "object") return false;
	const config = value as FastContextConfig;
	return (
		(config.modelKey === null || (typeof config.modelKey === "string" && !!config.modelKey)) &&
		levels.has(config.thinkingLevel)
	);
}
