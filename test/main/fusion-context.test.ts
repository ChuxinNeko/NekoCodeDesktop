import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { projectFusionLeadContext, FusionLeadContextProjection } from "../../src/main/fusion-context";

const call = (id: string, name: string, args: ToolCall["arguments"]): AgentMessage => ({
	...fauxAssistantMessage(""), content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, name: string, text: string, isError = false): AgentMessage => ({
	role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 1,
});
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const handoff = [call("handoff", "fusion_implement", { prompt: "Decisions", executionPlan: { acceptanceCriteria: ["Correct"] } }),
	result("handoff", "fusion_implement", "Accepted")];
const implementation = [call("write", "write", { path: "src/a.ts", content: "PRIVATE_LARGE_BODY".repeat(4000) }),
	result("write", "write", "Wrote src/a.ts"), call("test", "bash", { command: "bun test" }),
	result("test", "bash", "FAIL: expected 2 received 1", true)];
const review = [call("review", "fusion_review", { outcome: "needs_decision", summary: "Check failed", decision: "Resolve expected value",
	acceptance: [{ criterion: "Correct", status: "not_met", evidence: "Assertion failed" }] }), result("review", "fusion_review", "Recorded")];

describe("Fusion Lead request projection", () => {
	test("closed investigation keeps evidence but omits repeated source bodies without changing raw history", () => {
		const raw = [user("Implement requested change"), call("i", "fusion_investigate", { instruction: "Locate source" }),
			result("i", "fusion_investigate", "Accepted"),
			call("listing", "ls", { path: "." }), result("listing", "ls", "src/\nactual-entry.ts"),
			call("r", "read", { path: "src/a.ts" }),
			result("r", "read", "DECISIVE_ENTRY\n" + "REPEATED_SOURCE\n".repeat(5000)),
			call("report", "fusion_review", { outcome: "completed", summary: "src/a.ts:1 DECISIVE_ENTRY", acceptance: [] }),
			result("report", "fusion_review", "Recorded")];
		const before = JSON.stringify(raw); const projected = JSON.stringify(projectFusionLeadContext(raw));
		expect(projected).toContain("Fusion investigation context summary");
		expect(projected).toContain("DECISIVE_ENTRY");
		expect(projected).toContain("actual-entry.ts");
		expect(projected.length).toBeLessThan(before.length / 10);
		expect(JSON.stringify(raw)).toBe(before);
	});
	test("runtime budget return seals only Sidekick history and retains the unverified notice", () => {
		const raw: AgentMessage[] = [...handoff, ...implementation, {
			role: "custom", customType: "nekocode.fusion.document-return.v1", display: false,
			content: "Investigation budget exhausted; document not verified", timestamp: 1,
		}, fauxAssistantMessage("Lead verdict must stay outside summary")];
		const projected = projectFusionLeadContext(raw);
		expect(JSON.stringify(projected)).toContain("document not verified");
		expect(JSON.stringify(projected)).toContain("All acceptance remains unverified");
		expect(projected.at(-1)).toEqual(raw.at(-1));
		expect(JSON.stringify(projected)).not.toContain("PRIVATE_LARGE_BODY");
	});
	test("successive Lead requests preserve the already exposed prefix", () => {
		const projector = new FusionLeadContextProjection();
		const raw = [user("Task"), ...handoff, ...implementation, ...review];
		const first = projector.project(raw);
		const second = projector.project([...raw, fauxAssistantMessage("First verdict"), ...handoff, ...implementation, ...review]);
		expect(second.slice(0, first.length)).toEqual(first);
	});
	test("an exposed interrupted segment is never retroactively rewritten when it closes", () => {
		const projector = new FusionLeadContextProjection();
		const raw = [...handoff, ...implementation];
		const first = projector.project(raw);
		expect(first).toEqual(raw);
		const second = projector.project([...raw, ...review]);
		expect(second.slice(0, first.length)).toEqual(first);
		expect(second).toEqual([...raw, ...review]);
		projector.reset();
		expect(JSON.stringify(projector.project([...raw, ...review]))).not.toContain("PRIVATE_LARGE_BODY");
	});
	test("context edits invalidate the cache guard rather than resurrect stale evidence", () => {
		const projector = new FusionLeadContextProjection();
		projector.project([user("Old requirement"), ...handoff, ...implementation, ...review]);
		const result = projector.project([user("New requirement"), ...handoff, ...implementation, ...review]);
		expect(JSON.stringify(result)).not.toContain("Old requirement");
		expect(JSON.stringify(result)).toContain("New requirement");
	});
	test("leaves short implementations intact when a summary would be longer", () => {
		const raw = [...handoff, fauxAssistantMessage("No changes required")];
		expect(projectFusionLeadContext(raw)).toEqual(raw);
	});
	test("a rejected review remains unverified and its failure is retained", () => {
		const raw = [...handoff, ...implementation, review[0]!, result("review", "fusion_review", "Acceptance criteria mismatch", true),
			fauxAssistantMessage("Stopped without valid report")];
		const projected = JSON.stringify(projectFusionLeadContext(raw));
		expect(projected).toContain("All acceptance remains unverified");
		expect(projected).toContain("Acceptance criteria mismatch");
	});
	test("omits generated bodies, preserves observed failures and leaves raw history intact", () => {
		const raw = [user("Original task"), ...handoff, ...implementation, ...review, fauxAssistantMessage("Lead verdict")];
		const before = JSON.stringify(raw);
		const projected = projectFusionLeadContext(raw);
		const text = JSON.stringify(projected);
		expect(text).not.toContain("PRIVATE_LARGE_BODY");
		for (const evidence of ["Original task", "Decisions", "src/a.ts", "bun test", "FAIL", "not_met", "Resolve expected value", "Lead verdict"])
			expect(text).toContain(evidence);
		expect(text.length).toBeLessThan(before.length / 10);
		expect(JSON.stringify(raw)).toBe(before);
		expect(projectFusionLeadContext(projected)).toEqual(projected);
		const calls = projected.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((p): p is ToolCall => p.type === "toolCall"));
		const results = projected.filter((m) => m.role === "toolResult");
		expect(calls.map((c) => c.id)).toEqual(results.map((r) => r.toolCallId));
	});
	test("missing report cannot hide Lead's later verdict or claim acceptance", () => {
		const projected = projectFusionLeadContext([...handoff, ...implementation, fauxAssistantMessage("Sidekick stopped"),
			fauxAssistantMessage("Lead must inspect"), user("Next task")]);
		const text = JSON.stringify(projected);
		expect(text).toContain("All acceptance remains unverified");
		expect(projected.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("Lead must inspect"))).toBe(true);
		expect(projected.at(-1)).toEqual(user("Next task"));
	});
	test("rejected handoff and unmarked or compacted history are unchanged", () => {
		for (const raw of [[...implementation], [handoff[0]!, result("handoff", "fusion_implement", "Rejected", true), ...implementation]])
			expect(projectFusionLeadContext(raw)).toEqual(raw);
	});
	test("preserves system changes and boundaries through successive implementations", () => {
		const system: AgentMessage = { role: "system", content: "Role tools changed", timestamp: 1 };
		const raw = [...handoff, system, ...implementation, ...review, fauxAssistantMessage("First Lead review"),
			...handoff, ...implementation, ...review, fauxAssistantMessage("Final Lead review")];
		const projected = projectFusionLeadContext(raw);
		expect(projected).toContain(system);
		expect(projected.filter((m) => m.role === "user")).toHaveLength(2);
		expect(JSON.stringify(projected)).toContain("First Lead review");
		expect(JSON.stringify(projected)).toContain("Final Lead review");
	});
});
