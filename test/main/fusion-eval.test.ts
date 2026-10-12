import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { compareFusionRuns, summarizeFusionRun } from "../../src/main/fusion-eval";
import { FUSION_TASK_METRIC_ENTRY, FUSION_USAGE_ENTRY } from "../../src/main/fusion-usage";

const entry = (value: unknown) => value as SessionEntry;

describe("Fusion evaluation", () => {
	test("counts complete task cost once and preserves unknown prices", () => {
		const priced = summarizeFusionRun([
			entry({ type: "message", message: { role: "assistant", usage: { cost: { total: 1 }, cacheRead: 20 } } }),
			entry({ type: "custom", customType: FUSION_USAGE_ENTRY, data: {
				sourceEntryId: "helper-1", usage: { costUsd: 0.2, cacheRead: 10 } } }),
			entry({ type: "custom", customType: FUSION_USAGE_ENTRY, data: {
				sourceEntryId: "helper-1", usage: { costUsd: 0.2, cacheRead: 10 } } }),
			entry({ type: "custom", customType: FUSION_TASK_METRIC_ENTRY, data: {
				taskId: "worker-1", kind: "worker", outcome: "needs_escalation",
				acceptance: { met: 1, unverified: 2, notMet: 0 } } }),
		]);
		expect(priced).toMatchObject({ costUsd: 1.2, helperCostUsd: 0.2,
			modelCalls: 2, helperCalls: 1, cacheRead: 30, workers: 1,
			escalations: 1, unverifiedCriteria: 2 });
		const unpriced = summarizeFusionRun([entry({ type: "message", message: {
			role: "assistant", usage: { cacheRead: 1 } } })]);
		expect(unpriced.costUsd).toBeUndefined();
		expect(unpriced.unpricedCalls).toBe(1);
	});

	test("compares only independently judged and fully priced pairs", () => {
		const lead = summarizeFusionRun([entry({ type: "message", message: {
			role: "assistant", usage: { cost: { total: 2 } } } })]);
		const fusion = summarizeFusionRun([entry({ type: "message", message: {
			role: "assistant", usage: { cost: { total: 1 } } } })]);
		const unknown = summarizeFusionRun([entry({ type: "message", message: {
			role: "assistant", usage: {} } })]);
		const result = compareFusionRuns([
			{ id: "a", lead, fusion, leadPass: true, fusionPass: true },
			{ id: "b", lead, fusion: unknown, leadPass: true, fusionPass: false },
		]);
		expect(result).toMatchObject({ tasks: 2, judged: 2, priced: 1, comparable: 1,
			leadPassRate: 1, fusionPassRate: 0.5, leadCostUsd: 2,
			fusionCostUsd: 1, costChange: -0.5, qualityGapPp: -50,
			leadCostPerPassUsd: 2, fusionCostPerPassUsd: 1, unpricedCalls: 1 });
	});

	test("CLI reads paired saved sessions", () => {
		const dir = mkdtempSync(join(tmpdir(), "neko-fusion-eval-"));
		try {
			const makeSession = (price: number) => {
				const manager = SessionManager.create(dir, dir);
				manager.appendMessage({ role: "user", content: "Evaluate", timestamp: Date.now() });
				manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done" }],
					api: "openai-completions", provider: "test", model: "test", stopReason: "stop",
					timestamp: Date.now() + 1, usage: { input: 1, output: 1, cacheRead: 0,
						cacheWrite: 0, totalTokens: 2, cost: { input: price, output: 0,
							cacheRead: 0, cacheWrite: 0, total: price } } } as never);
				return manager.getSessionFile();
			};
			const leadSession = makeSession(2);
			const fusionSession = makeSession(1);
			const manifest = join(dir, "manifest.json");
			writeFileSync(manifest, JSON.stringify({ cases: [{ id: "case-1", leadSession,
				fusionSession, leadPass: true, fusionPass: true }] }));
			const run = spawnSync("bun", ["scripts/fusion-eval.ts", manifest], {
				cwd: process.cwd(), encoding: "utf8" });
			expect(run.status).toBe(0);
			expect(JSON.parse(run.stdout).summary).toMatchObject({ comparable: 1,
				leadCostUsd: 2, fusionCostUsd: 1, costChange: -0.5 });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});
