import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentCell, TurnUsage } from "../../src/shared/agent";
import { FUSION_ENTRY } from "../../src/main/fusion-config";
import { FAST_CONTEXT_USAGE_ENTRY, FUSION_USAGE_ENTRY, withFusionUsage } from "../../src/main/fusion-usage";
import { aggregateTurnUsage, projectMessages, type ProjectableMessage } from "../../src/main/agent-projection";

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
	test("attributes inline Sidekick calls by actual model instead of putting the whole main turn in Lead", () => {
		const messages: ProjectableMessage[] = [{ role: "user", timestamp: 1, content: [{ type: "text", text: "Task" }] },
			...[["anthropic", "lead", 100], ["zai", "side", 300], ["anthropic", "lead", 50]].map(([provider, model, total], i) => ({
				role: "assistant", provider: String(provider), model: String(model), timestamp: i + 2,
				content: [{ type: "text", text: "Reply" }], usage: { input: Number(total), output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: Number(total) },
			}))];
		const projected = projectMessages(messages);
		const branch = [custom(FUSION_ENTRY, FUSION), ...messages.map((message) => ({ type: "message", message }) as SessionEntry)];
		const out = withFusionUsage(projected, branch);
		const merged = out.flatMap((cell) => cell.type === "assistant" && cell.usage ? [cell.usage] : []).at(-1)!;
		expect(merged.totalTokens).toBe(450);
		expect(merged.fusion?.lead.totalTokens).toBe(150);
		expect(merged.fusion?.lead.calls).toBe(2);
		expect(merged.fusion?.sidekick.usage?.totalTokens).toBe(300);
		expect(merged.fusion?.sidekick.usage?.calls).toBe(1);
		expect(merged.fusion?.breakdown?.filter((entry) => entry.source === "main")).toHaveLength(2);
		// Reopening legacy history rehydrates attribution even if the cell has only a merged total.
		const legacy = { ...aggregateTurnUsage(messages.slice(1))!, modelBreakdown: undefined };
		const recovered = result(withFusionUsage(cells(legacy), branch))!;
		expect(recovered.fusion?.sidekick.usage?.totalTokens).toBe(300);
	});
	test("adds all Sidekick sources exactly once and puts a Lead helper into Lead", () => {
		const main = { ...usage("anthropic", "lead", 140), modelBreakdown: [usage("anthropic", "lead", 100), usage("zai", "side", 40)] };
		const search = custom(FAST_CONTEXT_USAGE_ENTRY, { turnTimestamp: 1, sourceEntryId: "search-call", usage: usage("zai", "side", 20) });
		const merged = result(withFusionUsage(cells(main), [custom(FUSION_ENTRY, FUSION), user(1),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1, usage: usage("zai", "side", 30) }),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1, usage: usage("anthropic", "lead", 10) }), search, search]))!;
		expect(merged.totalTokens).toBe(200);
		expect(merged.fusion?.lead.totalTokens).toBe(110);
		expect(merged.fusion?.sidekick.usage?.totalTokens).toBe(90);
		expect(merged.fastContext?.search.usage?.totalTokens).toBe(20);
		expect(merged.fusion?.lead.totalTokens! + merged.fusion?.sidekick.usage?.totalTokens!).toBe(merged.totalTokens);
	});
	test("identical configured models are not counted twice or arbitrarily labeled Lead", () => {
		const main = usage("anthropic", "lead", 100);
		const merged = result(withFusionUsage(cells(main), [custom(FUSION_ENTRY, { ...FUSION, sidekickModelKey: FUSION.leadModelKey }), user(1)]))!;
		expect(merged.totalTokens).toBe(100);
		expect(merged.fusion?.lead.calls).toBe(0);
		expect(merged.fusion?.sidekick.usage).toBeUndefined();
		expect(merged.fusion?.unattributed?.totalTokens).toBe(100);
		expect(merged.fusion?.attributionAmbiguous).toBe(true);
	});
	test("legacy merged totals without call records remain unattributed", () => {
		const main = { ...usage("anthropic", "lead", 100), calls: 3 };
		const merged = result(withFusionUsage(cells(main), [custom(FUSION_ENTRY, FUSION), user(1)]))!;
		expect(merged.totalTokens).toBe(100);
		expect(merged.fusion?.unattributed?.totalTokens).toBe(100);
		expect(merged.fusion?.lead.calls).toBe(0);
	});
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

	test("includes compaction and warming with task/model attribution without double counting", () => {
		const lead = usage("anthropic", "lead", 100);
		const record = (kind: string, model: string, tokens: number, id: string) => custom(FUSION_USAGE_ENTRY, {
			turnTimestamp: 1, parentEntryId: "user-1", taskId: "worker-1", kind, sourceEntryId: id,
			usage: { ...usage("anthropic", model, tokens), costUsd: tokens / 1000 },
		});
		const out = withFusionUsage(cells(lead), [custom(FUSION_ENTRY, FUSION), { ...user(1), id: "user-1" },
			record("inference", "side", 30, "call-1"), record("compaction", "side", 10, "compact-1"),
			record("cache-warm", "side", 5, "warm-1"), record("cache-warm", "side", 5, "warm-1"),
			record("inference", "lead", 20, "call-2"),
		]);
		const merged = result(out)!;
		expect(merged.totalTokens).toBe(165);
		expect(merged.costUsd).toBeUndefined(); // Lead price is absent; helper-only spend is not a total.
		expect(merged.durationMs).toBe(lead.durationMs);
		expect(merged.fusion?.breakdown).toHaveLength(5);
		expect(merged.fusion?.breakdown?.filter((entry) => entry.source === "auxiliary").map((entry) => entry.kind)).toEqual(["inference", "compaction", "cache-warm", "inference"]);
		expect(merged.fusion?.breakdown?.at(-1)?.usage.model).toBe("lead");
		expect(merged.fusion?.breakdown?.filter((entry) => entry.source === "auxiliary").every((entry) => entry.taskId === "worker-1")).toBe(true);
	});
	test("shows a total price only when Lead and every helper call are priced", () => {
		const lead = { ...usage("anthropic", "lead", 100), costUsd: 0.5 };
		const priced = { ...usage("zai", "side", 30), costUsd: 0.1 };
		const branch = [custom(FUSION_ENTRY, FUSION), user(1),
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1, usage: priced })];
		expect(result(withFusionUsage(cells(lead), branch))?.costUsd).toBeCloseTo(0.6);
		branch.push(custom(FAST_CONTEXT_USAGE_ENTRY, { turnTimestamp: 1, usage: usage("zai", "scan", 20) }));
		expect(result(withFusionUsage(cells(lead), branch))?.costUsd).toBeUndefined();
	});
	test("does not attach usage from another history branch with the same timestamp", () => {
		const lead = usage("anthropic", "lead", 100);
		const out = withFusionUsage(cells(lead), [custom(FUSION_ENTRY, FUSION), { ...user(1), id: "new-user" },
			custom(FUSION_USAGE_ENTRY, { turnTimestamp: 1, parentEntryId: "old-user", usage: usage("zai", "side", 30) }),
		]);
		expect(result(out)?.totalTokens).toBe(100);
		expect(result(out)?.fusion?.breakdown?.filter((entry) => entry.source === "auxiliary")).toHaveLength(0);
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
