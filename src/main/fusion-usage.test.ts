import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentCell, TurnUsage } from "../shared/agent";
import { FUSION_ENTRY } from "./fusion-config";
import { FUSION_USAGE_ENTRY, withFusionUsage } from "./fusion-usage";

const config = { leadModelKey: "provider/lead", leadThinkingLevel: "high", sidekickModelKey: "provider/sidekick", sidekickThinkingLevel: "low" };
const base = { id: "entry", parentId: null, timestamp: "2026-09-19T00:00:00Z" };
const custom = (customType: string, data: unknown): SessionEntry => ({ ...base, type: "custom", customType, data });
const user = (timestamp: number): SessionEntry => ({ ...base, type: "message", message: { role: "user", content: "go", timestamp } });
const usage = (model: string, input: number): TurnUsage => ({ provider: "provider", model, calls: 1, input, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: input + 30, modelMs: 1000, durationMs: 3000, costUsd: 0.01 });
const cells = (timestamp: number): AgentCell[] => [
	{ id: `user-${timestamp}`, type: "user", text: "go", timestamp },
	{ id: `assistant-${timestamp}`, type: "assistant", text: "done", thinking: "", streaming: false, timestamp: timestamp + 1, usage: usage("lead", 100) },
];
const assistantUsage = (result: AgentCell[], index = 1) => {
	const cell = result[index];
	return cell.type === "assistant" ? cell.usage : undefined;
};

describe("Fusion turn usage", () => {
	test("separates roles and sums all Sidekick calls without duplicating elapsed time", () => {
		const result = assistantUsage(withFusionUsage(cells(1000), [
			custom(FUSION_ENTRY, config), user(1000),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1000, usage: usage("sidekick", 200) }),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1000, usage: usage("sidekick", 300) }),
		]));
		expect(result).toMatchObject({ calls: 3, input: 600, output: 30, totalTokens: 690, durationMs: 3000 });
		expect(result?.fusion?.lead).toMatchObject({ model: "lead", calls: 1, input: 100 });
		expect(result?.fusion?.sidekick.usage).toMatchObject({ model: "sidekick", calls: 2, input: 500, modelMs: 2000, durationMs: 6000 });
		expect(result?.costUsd).toBeCloseTo(0.03);
	});

	test("a late child is charged to its originating turn even after disabling Fusion", () => {
		const result = withFusionUsage([...cells(1000), ...cells(2000)], [
			custom(FUSION_ENTRY, config), user(1000), custom(FUSION_ENTRY, null), user(2000),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1000, usage: usage("sidekick", 200) }),
		]);
		expect(assistantUsage(result)?.totalTokens).toBe(360);
		expect(assistantUsage(result, 3)?.fusion).toBeUndefined();
		expect(assistantUsage(result, 3)?.totalTokens).toBe(130);
	});

	test("roles stay distinct when both use the same model", () => {
		const result = assistantUsage(withFusionUsage(cells(1000), [
			custom(FUSION_ENTRY, { ...config, sidekickModelKey: config.leadModelKey }), user(1000),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1000, usage: usage("lead", 200) }),
		]));
		expect(result?.fusion?.lead.input).toBe(100);
		expect(result?.fusion?.sidekick.usage?.input).toBe(200);
	});

	test("historical turns without child records keep an explicitly unknown Sidekick", () => {
		const result = assistantUsage(withFusionUsage(cells(1000), [custom(FUSION_ENTRY, config), user(1000)]));
		expect(result?.fusion?.sidekick).toEqual({ provider: "provider", model: "sidekick", usage: undefined });
		expect(result?.totalTokens).toBe(130);
	});

	test("withholds the active turn's panel while Sidekick is running", () => {
		const entries = [custom(FUSION_ENTRY, config), user(1000), user(2000)];
		const result = withFusionUsage([...cells(1000), ...cells(2000)], entries, true);
		expect(assistantUsage(result)?.fusion).toBeDefined();
		expect(assistantUsage(result, 3)).toBeUndefined();
	});

	test("ignores malformed saved child records", () => {
		const result = assistantUsage(withFusionUsage(cells(1000), [
			custom(FUSION_ENTRY, config), user(1000),
			custom(FUSION_USAGE_ENTRY, null),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1000, usage: { ...usage("sidekick", 200), input: "200" } }),
		]));
		expect(result?.fusion?.sidekick.usage).toBeUndefined();
	});
});
