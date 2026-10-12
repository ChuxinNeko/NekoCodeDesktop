import { describe, expect, test } from "bun:test";
import { createFusionReportTool, createFusionUpgradeTool, fusionTaskResult } from "../../src/main/fusion-report-tool";
import { FusionRoutingState } from "../../src/main/fusion-routing";
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
	test("Lead stays the brain even after successful routine execution", () => {
		const routing = new FusionRoutingState("main");
		routing.request({ workload: "routine", risk: "low", reason: "Plan ready", evidence: "Bounded edits remain" });
		routing.observe("edit", { path: "a.ts" }, "updated", false);
		expect(routing.initialRole()).toBe("lead");
		expect(routing.atCacheBoundary(config, "a/lead")).toBeUndefined();
		expect(routing.atCacheBoundary(config, "b/side")?.role).toBe("lead");
	});
	test("ordinary fact gathering uses Sidekick, sensitive work retains Lead", () => {
		expect(new FusionRoutingState("auxiliary", "Locate the theme entry point").initialRole()).toBe("sidekick");
		expect(new FusionRoutingState("auxiliary", "Analyze authentication boundary").initialRole()).toBe("lead");
	});
	test("repeated correctness failures stop worker effects without waiting for compaction", () => {
		const routing = new FusionRoutingState("auxiliary", "bounded work", true);
		routing.observe("bash", { command: "bun test" }, "Assertion: expected 2, received 1", true);
		expect(routing.allowsTool("edit")).toBe(true);
		routing.observe("bash", { command: "bun test" }, "Assertion: expected 2, received 1", true);
		expect(routing.allowsTool("edit")).toBe(false);
		expect(routing.allowsTool("bash")).toBe(false);
		expect(routing.allowsTool("fusion_report")).toBe(true);
		expect(routing.snapshot()).toMatchObject({ safeToContinue: false, environmentalSignal: false });
	});
	test("repeated network failures do not become capability escalations", () => {
		const routing = new FusionRoutingState("auxiliary", "bounded work", true);
		for (let i = 0; i < 3; i++) routing.observe("bash", "fetch", "ECONNRESET", true);
		expect(routing.snapshot().safeToContinue).toBe(true);
		expect(routing.atCacheBoundary(config, "b/side")).toBeUndefined();
	});
	test("disabled routing stays fixed and malformed flags are rejected", () => {
		expect(isFusionConfig(config)).toBe(true);
		expect(isFusionConfig({ ...config, adaptiveRouting: "yes" })).toBe(false);
		expect(new FusionRoutingState("main").atCacheBoundary({ ...config, adaptiveRouting: false }, "b/side")).toBeUndefined();
	});
	test("risk evidence selects Lead only at a boundary and does not grant MCP authority", () => {
		const routing = new FusionRoutingState("auxiliary", "bounded work", true);
		expect(routing.atCacheBoundary(config, "b/side")).toBeUndefined();
		expect(() => routing.request({ workload: "review", risk: "high", reason: "Correctness risk", evidence: " " }))
			.toThrow("concrete evidence");
		routing.request({ workload: "review", risk: "high", reason: "Correctness risk", evidence: "Conflicting invariants", safeToContinue: false });
		expect(routing.atCacheBoundary(config, "b/side")?.role).toBe("lead");
		expect(routing.allowsTool("mcp__demo__echo")).toBe(false);
		expect(routing.allowsTool("read")).toBe(true);
		expect(routing.atCacheBoundary(config, "a/lead")).toBeUndefined();
	});
	test("routine success permits Sidekick at a boundary and failed routes do not loop", () => {
		const routing = new FusionRoutingState("auxiliary", "bounded work", true);
		expect(routing.atCacheBoundary(config, "a/lead")).toBeUndefined();
		routing.observe("edit", { path: "a.ts" }, "updated", false);
		expect(routing.atCacheBoundary(config, "a/lead")?.role).toBe("sidekick");
		routing.recordAttempt("sidekick", false);
		expect(routing.atCacheBoundary(config, "a/lead")).toBeUndefined();
		expect(routing.atCacheBoundary({ ...config, sidekickModelKey: "a/lead" }, "a/lead")).toBeUndefined();
	});
	test("a successful edit and a low-risk hint cannot downgrade unresolved high-risk work", () => {
		const routing = new FusionRoutingState("auxiliary", "Update authentication boundary", true);
		expect(routing.initialRole()).toBe("lead");
		routing.observe("edit", { path: "auth.ts" }, "updated", false);
		routing.request({ workload: "routine", risk: "low", reason: "Edit completed",
			evidence: "The edit tool returned successfully" });
		expect(routing.atCacheBoundary(config, "a/lead")).toBeUndefined();
		expect(routing.atCacheBoundary(config, "b/side")?.role).toBe("lead");
	});
});
