import { describe, expect, test } from "bun:test";
import { FAST_CONTEXT_USAGE_ENTRY, FUSION_USAGE_ENTRY } from "./fusion-usage";
import { consumeLine, emptyScan } from "./token-stats";

const TS = "2025-01-01T00:00:00.000Z";

function assistant(input: number, provider = "anthropic", model = "lead"): string {
	return JSON.stringify({
		type: "message", timestamp: TS,
		message: { role: "assistant", provider, model, timestamp: Date.parse(TS),
			usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input } },
	});
}

function helper(customType: string, input: number, provider: string, model: string): string {
	return JSON.stringify({
		type: "custom", customType, timestamp: TS,
		data: { turnTimestamp: 1, usage: { provider, model, calls: 1, input, output: 0,
			cacheRead: 0, cacheWrite: 0, totalTokens: input } },
	});
}

describe("consumeLine usage accounting", () => {
	test("assistant message usage still counts", () => {
		const scan = emptyScan();
		consumeLine(scan, assistant(100));
		expect(scan.counts.calls).toBe(1);
		expect(scan.counts.input).toBe(100);
	});

	test("Fusion helper usage counts under its own model", () => {
		const scan = emptyScan();
		consumeLine(scan, helper(FUSION_USAGE_ENTRY, 30, "zai", "side"));
		expect(scan.counts.calls).toBe(1);
		expect(scan.counts.input).toBe(30);
		const [bucket] = scan.buckets.values();
		expect(bucket.provider).toBe("zai");
		expect(bucket.model).toBe("side");
	});

	test("Fast Context helper usage counts", () => {
		const scan = emptyScan();
		consumeLine(scan, helper(FAST_CONTEXT_USAGE_ENTRY, 20, "openai", "scan"));
		expect(scan.counts.input).toBe(20);
		const [bucket] = scan.buckets.values();
		expect(bucket.model).toBe("scan");
	});

	test("lead and helper usages add exactly once", () => {
		const scan = emptyScan();
		consumeLine(scan, assistant(100));
		consumeLine(scan, helper(FUSION_USAGE_ENTRY, 30, "zai", "side"));
		consumeLine(scan, helper(FAST_CONTEXT_USAGE_ENTRY, 20, "openai", "scan"));
		expect(scan.counts.calls).toBe(3);
		expect(scan.counts.input).toBe(150);
		expect(scan.buckets.size).toBe(3);
	});

	test("malformed and unrelated custom entries are ignored", () => {
		const scan = emptyScan();
		consumeLine(scan, JSON.stringify({ type: "custom", customType: "other.v1", timestamp: TS, data: {} }));
		consumeLine(scan, JSON.stringify({ type: "custom", customType: FUSION_USAGE_ENTRY, timestamp: TS }));
		consumeLine(scan, JSON.stringify({ type: "custom", customType: FUSION_USAGE_ENTRY, timestamp: TS, data: { usage: "nope" } }));
		consumeLine(scan, JSON.stringify({ type: "custom", customType: FAST_CONTEXT_USAGE_ENTRY, timestamp: TS,
			data: { turnTimestamp: 1, usage: { provider: "zai", model: "m", calls: 1, totalTokens: 0 } } }));
		expect(scan.counts.calls).toBe(0);
		expect(scan.counts.input).toBe(0);
	});
});
