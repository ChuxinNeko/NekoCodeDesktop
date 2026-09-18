import { describe, expect, test } from "bun:test";
import type { TurnUsage } from "./agent";
import { formatCost, formatDuration, formatRate, formatTokens, usageStats } from "./usage";

function usage(patch: Partial<TurnUsage> = {}): TurnUsage {
	return {
		provider: "anthropic",
		model: "claude-opus-4-8",
		calls: 3,
		input: 200,
		output: 500,
		cacheRead: 700,
		cacheWrite: 100,
		totalTokens: 1500,
		...patch,
	};
}

describe("usageStats", () => {
	test("counts cache traffic as part of the prompt, the way pi bills it", () => {
		const stats = usageStats(usage());
		expect(stats.promptTokens).toBe(1000);
		expect(stats.cacheHitRate).toBe(0.7);
	});

	test("reports no hit rate when there was no prompt to hit", () => {
		expect(usageStats(usage({ input: 0, cacheRead: 0, cacheWrite: 0 })).cacheHitRate).toBeNull();
	});

	test("rates output against model time, not the turn the tools padded out", () => {
		const stats = usageStats(usage({ output: 500, durationMs: 20_000, modelMs: 4000 }));
		expect(stats.durationSeconds).toBe(20);
		expect(stats.modelSeconds).toBe(4);
		expect(stats.tokensPerSecond).toBe(125);
	});

	test("withholds speed without a duration, or with one too short to divide by", () => {
		expect(usageStats(usage()).tokensPerSecond).toBeNull();
		expect(usageStats(usage({ modelMs: 0 })).tokensPerSecond).toBeNull();
		expect(usageStats(usage({ output: 0, modelMs: 4000 })).tokensPerSecond).toBeNull();
	});
});

describe("formatting", () => {
	test("groups thousands and keeps small figures legible", () => {
		expect(formatTokens(1_234_567)).toBe("1,234,567");
		expect(formatDuration(4.237)).toBe("4.24s");
		expect(formatDuration(95)).toBe("1m 35s");
		expect(formatRate(125)).toBe("125.0 t/s");
	});

	test("shows sub-cent cost instead of rounding it to nothing", () => {
		expect(formatCost(0.0031)).toBe("$0.0031");
		expect(formatCost(1.238)).toBe("$1.24");
		expect(formatCost(0)).toBe("$0");
	});
});
