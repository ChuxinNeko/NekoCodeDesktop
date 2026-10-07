import { describe, expect, test } from "bun:test";
import { createFusionReportTool, createFusionUpgradeTool, fusionTaskResult } from "../../src/main/fusion-report-tool";
import { fusionRouteAtCompaction } from "../../src/main/fusion-routing";
import type { FusionTaskReport } from "../../src/shared/workflow";
import { isFusionConfig } from "../../src/shared/fusion";

const config = { leadModelKey: "a/lead", leadThinkingLevel: "high", sidekickModelKey: "b/side", sidekickThinkingLevel: "low" } as const;
const report = (): FusionTaskReport => ({ outcome: "completed", summary: "Ready for review",
	acceptance: [{ criterion: "Preserve cancellation", status: "unverified", evidence: "No check was run" }] });

describe("Fusion outcome protocol", () => {
	test("unverified work is not implicitly accepted", () => {
		expect(fusionTaskResult("Done").outcome).toBe("needs_decision");
		expect(fusionTaskResult("Done", report()).text).toContain("unverified");
	});
	test("unmet acceptance and escalations without evidence/questions are rejected", async () => {
		const tool = createFusionReportTool(() => undefined);
		const value = report(); value.acceptance[0].status = "not_met";
		await expect(tool.execute("1", value, undefined, undefined, {} as never)).rejects.toThrow("Unmet acceptance");
		value.outcome = "needs_escalation";
		await expect(tool.execute("2", value, undefined, undefined, {} as never)).rejects.toThrow("concrete evidence");
		value.decision = "Invariant unclear: Lead must choose transaction semantics";
		const accepted: FusionTaskReport[] = [];
		await createFusionReportTool((value) => accepted.push(value)).execute("3", value, undefined, undefined, {} as never);
		expect(accepted[0].outcome).toBe("needs_escalation");
	});
	test("upgrade requests record evidence without changing a model", async () => {
		const requests: unknown[] = [];
		const result = await createFusionUpgradeTool((value) => requests.push(value)).execute("1", {
			reason: "Cannot establish correctness", evidence: "Conflicting cancellation invariants",
		}, undefined, undefined, {} as never);
		expect(requests).toHaveLength(1);
		expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("not executed") })]);
	});
});

describe("conservative compaction routing", () => {
	const request = { reason: "Correctness risk", evidence: "Conflicting invariants" };
	test("old configs stay fixed and malformed routing flags are rejected", () => {
		expect(isFusionConfig(config)).toBe(true);
		expect(isFusionConfig({ ...config, adaptiveRouting: "yes" })).toBe(false);
		expect(fusionRouteAtCompaction(config, "b/side", request, 0)).toBeUndefined();
	});
	test("only explicit evidence can upgrade to the selected Lead", () => {
		const adaptive = { ...config, adaptiveRouting: true };
		expect(fusionRouteAtCompaction(adaptive, "b/side", undefined, 0)).toBeUndefined();
		expect(fusionRouteAtCompaction(adaptive, "b/side", { ...request, evidence: " " }, 0)).toBeUndefined();
		expect(fusionRouteAtCompaction(adaptive, "b/side", request, 0)).toBe("lead");
		expect(fusionRouteAtCompaction(adaptive, "unknown/model", request, 0)).toBeUndefined();
	});
	test("prevents oscillation and returns later routine tasks to Sidekick only at a boundary", () => {
		const adaptive = { ...config, adaptiveRouting: true };
		expect(fusionRouteAtCompaction(adaptive, "a/lead", request, 0)).toBeUndefined();
		expect(fusionRouteAtCompaction(adaptive, "a/lead", undefined, 0)).toBe("sidekick");
		expect(fusionRouteAtCompaction(adaptive, "a/lead", undefined, 1)).toBeUndefined();
		expect(fusionRouteAtCompaction({ ...adaptive, sidekickModelKey: "a/lead" }, "a/lead", request, 0)).toBeUndefined();
	});
});
