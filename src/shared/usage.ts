import type { TurnUsage } from "./agent";

/**
 * The figures a usage panel shows that are not simply read off the message.
 *
 * Kept apart from the component so the arithmetic — which is the part that can
 * be wrong — is tested directly, and so "prompt tokens" means the same thing
 * here as it does in pi's own cache accounting.
 */
export interface UsageStats {
	/** Everything the prompt was billed for: full-rate input plus cache traffic. */
	promptTokens: number;
	/** Share of the prompt served from cache, or null when there was no prompt. */
	cacheHitRate: number | null;
	/** The whole turn, tool execution included. */
	durationSeconds: number | null;
	/** Time inside the model calls, which is the part that generated tokens. */
	modelSeconds: number | null;
	/**
	 * Output tokens per second of *model* time. Dividing by the turn instead
	 * would report a rate that falls the longer the tools took, which says
	 * nothing about the model.
	 */
	tokensPerSecond: number | null;
}

/** A sub-millisecond span is a clock artifact — dividing by it invents a rate. */
function seconds(ms: number | undefined): number | null {
	return ms !== undefined && ms >= 1 ? ms / 1000 : null;
}

export function usageStats(usage: TurnUsage): UsageStats {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const modelSeconds = seconds(usage.modelMs);
	return {
		promptTokens,
		cacheHitRate: promptTokens > 0 ? usage.cacheRead / promptTokens : null,
		durationSeconds: seconds(usage.durationMs),
		modelSeconds,
		tokensPerSecond:
			modelSeconds !== null && usage.output > 0 ? usage.output / modelSeconds : null,
	};
}

/** Thousands separators, so six-figure context sizes stay readable at a glance. */
export function formatTokens(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

export function formatPercent(ratio: number): string {
	return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatRate(tokensPerSecond: number): string {
	return `${tokensPerSecond.toFixed(1)} t/s`;
}

/** Cost is sub-cent often enough that two decimals would read as a flat $0.00. */
export function formatCost(usd: number): string {
	if (usd === 0) return "$0";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}
