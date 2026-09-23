import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentCell, TurnUsage } from "../shared/agent";
import { FUSION_ENTRY } from "./fusion-config";
import { FAST_CONTEXT_USAGE_ENTRY, FUSION_USAGE_ENTRY, withFusionUsage } from "./fusion-usage";

const FUSION = {
	leadModelKey: "anthropic/lead",
	leadThinkingLevel: "high",
	sidekickModelKey: "zai/side",
	sidekickThinkingLevel: "low",
} as const;

function usage(provider: string, model: string, total: number): TurnUsage {
	return {
		provider, model, calls: 1, input: total, output: 0,
		cacheRead: 0, cacheWrite: 0, totalTokens: total, durationMs: 10,
	};
}

function user(ts: number): SessionEntry {
	return { type: "message", message: { role: "user", timestamp: ts } } as SessionEntry;
}

function custom(customType: string, data: unknown): SessionEntry {
	return { type: "custom", customType, data } as SessionEntry;
}

function cells(lead: TurnUsage): AgentCell[] {
	return [
		{ id: "u1", type: "user", text: "hi", timestamp: 1 },
		{
			id: "a1", type: "assistant", text: "done", thinking: "",
			streaming: false, timestamp: 2, usage: lead,
		},
	];
}

function result(list: AgentCell[]) {
	const cell = list[1];
	return cell.type === "assistant" ? cell.usage : undefined;
}

describe("withFusionUsage", () => {
	test("leaves a plain turn untouched", () => {
		const lead = usage("anthropic", "lead", 100);
		const out = withFusionUsage(cells(lead), [user(1)]);
		expect(result(out)).toBe(lead);
	});

	test("aggregates Fast Context usage without Fusion", () => {
		const lead = usage("anthropic", "lead", 100);
		const out = withFusionUsage(cells(lead), [
			user(1),
			custom(FAST_CONTEXT_USAGE_ENTRY, { turnTimestamp: 1, usage: usage("zai", "scan", 40) }),
		]);
		const merged = result(out)!;
		expect(merged.totalTokens).toBe(140);
		expect(merged.provider).toBe("anthropic");
		expect(merged.model).toBe("lead");
		expect(merged.fusion).toBeUndefined();
		expect(merged.fastContext?.primary).toBe(lead);
		expect(merged.fastContext?.search).toMatchObject({
			provider: "zai", model: "scan",
		});
		expect(merged.fastContext?.search.usage?.totalTokens).toBe(40);
	});

	test("reports Fusion and Fast Context with distinct roles and models", () => {
		const lead = usage("anthropic", "lead", 100);
		const out = withFusionUsage(cells(lead), [
			custom(FUSION_ENTRY, FUSION),
			user(1),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1, usage: usage("zai", "side", 30) }),
			custom(FAST_CONTEXT_USAGE_ENTRY, { turnTimestamp: 1, usage: usage("openai", "scan", 20) }),
		]);
		const merged = result(out)!;
		expect(merged.totalTokens).toBe(150);
		expect(merged.fusion?.lead).toBe(lead);
		expect(merged.fusion?.sidekick).toMatchObject({ provider: "zai", model: "side" });
		expect(merged.fusion?.sidekick.usage?.totalTokens).toBe(30);
		expect(merged.fastContext?.primary).toBe(lead);
		expect(merged.fastContext?.search).toMatchObject({ provider: "openai", model: "scan" });
		expect(merged.fastContext?.search.usage?.totalTokens).toBe(20);
	});

	test("ignores sidekick parts recorded without a Fusion config", () => {
		const lead = usage("anthropic", "lead", 100);
		const out = withFusionUsage(cells(lead), [
			user(1),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1, usage: usage("zai", "side", 30) }),
		]);
		expect(result(out)).toBe(lead);
	});

	test("ignores malformed helper records", () => {
		const lead = usage("anthropic", "lead", 100);
		const out = withFusionUsage(cells(lead), [
			user(1),
			custom(FAST_CONTEXT_USAGE_ENTRY, { turnTimestamp: "x", usage: usage("zai", "scan", 10) }),
			custom(FAST_CONTEXT_USAGE_ENTRY, {
				turnTimestamp: 1,
				usage: { ...usage("zai", "scan", -5) },
			}),
			custom(FAST_CONTEXT_USAGE_ENTRY, { turnTimestamp: 1 }),
		]);
		expect(result(out)).toBe(lead);
	});

	test("hides the running turn's usage while helpers run", () => {
		const lead = usage("anthropic", "lead", 100);
		const out = withFusionUsage(cells(lead), [
			custom(FUSION_ENTRY, FUSION),
			user(1),
		], true);
		expect(result(out)).toBeUndefined();
	});
});
