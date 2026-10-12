import { describe, expect, test } from "bun:test";
import type { TaskInput, TaskStep } from "../../src/shared/workflow";
import { fusionTaskError, taskHandoffPrompt, FusionExecutionEvidence, FusionInlineHandoffState } from "../../src/main/fusion-handoff";

const task = (): TaskInput => ({
	description: "Fix retry", prompt: "Preserve cancellation and existing changes.", kind: "worker", writablePaths: ["."],
	executionPlan: {
		steps: ["Add bounded retries", "Cover cancellation"],
		constraints: ["Do not commit or overwrite user changes"],
		acceptanceCriteria: ["Cancellation never retries"],
		verification: { mode: "run", checks: ["bun test retry.test.ts"] },
	},
});

describe("Fusion handoff", () => {
	test("restored contracts preserve scope and failure counts and reject malformed authority", () => {
		const original = new FusionInlineHandoffState(); original.accept(original.prepare(task())); original.report();
		const restored = new FusionInlineHandoffState(); expect(restored.restore(original.snapshot())).toBe(true);
		expect(restored.prepare({ resume: true, instruction: "Fix the observed failure", resolution: "Use the concrete correction" }).writablePaths).toEqual(["."]);
		restored.report(); expect(() => restored.prepare(task())).toThrow("failed twice");
		for (const value of [null, { failed: "invalid" }, { failed: [], previous: { ...task(), writablePaths: [] } },
			{ failed: [], previous: { ...task(), prompt: 123 } }, { failed: [["invalid-hash", 1]] }]) expect(restored.restore(value)).toBe(false);
	});
	test("compact edits preserve scope, criterion and explicit verification restrictions", () => {
		const state = new FusionInlineHandoffState();
		const compact = { instruction: "Fix the typo", path: "src/a.ts", acceptanceCriterion: "Correct spelling", skipReason: "User forbids tests" };
		const plan = state.prepare(compact);
		expect(fusionTaskError(plan)).toBeUndefined();
		expect(plan.writablePaths).toEqual(["src/a.ts"]);
		expect(plan.executionPlan?.acceptanceCriteria).toEqual([compact.acceptanceCriterion]);
		expect(plan.executionPlan?.verification).toEqual({ mode: "skip", checks: [] });
		expect(() => state.prepare({ ...compact, check: "bun test" })).toThrow("exactly one");
		expect(() => state.prepare({ ...compact, skipReason: "" })).toThrow("exactly one");
	});
	test("resume preserves verification and scope, and cannot survive a new task reset", () => {
		const state = new FusionInlineHandoffState();
		const original = task(); state.accept(state.prepare(original));
		const resumed = state.prepare({ resume: true, instruction: "Add the missing abort check", resolution: "Cancellation must be checked before scheduling" });
		expect(resumed.writablePaths).toEqual(original.writablePaths);
		expect(resumed.executionPlan?.verification).toEqual(original.executionPlan?.verification);
		expect(resumed.executionPlan?.acceptanceCriteria).toEqual(original.executionPlan?.acceptanceCriteria);
		expect(resumed.executionPlan?.steps).toEqual(["Add the missing abort check"]);
		state.reset();
		expect(() => state.prepare({ resume: true, instruction: "Continue", resolution: "Fixed" })).toThrow("No inline plan");
	});
	test("two identical unresolved attempts require a new decision instead of blind ping-pong", () => {
		const state = new FusionInlineHandoffState();
		for (let i = 0; i < 2; i++) { state.accept(state.prepare(task())); state.report(); }
		expect(() => state.prepare(task())).toThrow("failed twice");
		const correction = state.prepare({ resume: true, instruction: "Check abort before setTimeout", resolution: "Move the cancellation guard before retry scheduling" });
		expect(correction.writablePaths).toEqual(["."]);
		state.accept(correction); state.report();
		state.accept(state.prepare({ resume: true, instruction: "Check abort before setTimeout", resolution: "Move the cancellation guard before retry scheduling" }));
		state.report();
		expect(() => state.prepare({ resume: true, instruction: "Check abort before setTimeout", resolution: "Move the cancellation guard before retry scheduling" })).toThrow("failed twice");
		state.reset(); expect(() => state.prepare(task())).not.toThrow();
	});
	test("validates and preserves Lead's decision brief", () => {
		const input = task();
		input.executionPlan!.decisionBrief = { objective: "Keep cancellation immediate",
			decisions: ["Check cancellation before scheduling retries"], evidence: ["retry.ts:42 abort handler"],
			stopConditions: ["Cancellation requires an API change"] };
		expect(fusionTaskError(input)).toBeUndefined();
		expect(taskHandoffPrompt(input)).toContain("retry.ts:42 abort handler");
		input.executionPlan!.decisionBrief.stopConditions = [];
		expect(fusionTaskError(input)).toContain("stopConditions");
	});
	test("rejects unplanned workers but keeps exploration compatible", () => {
		expect(fusionTaskError({ kind: "worker", prompt: "Implement it" })).toContain("requires executionPlan");
		expect(fusionTaskError({ kind: "explore" })).toBeUndefined();
		expect(fusionTaskError(task())).toBeUndefined();
	});
	test("rejects incomplete, blank and unbounded plans", () => {
		for (const field of ["steps", "acceptanceCriteria"] as const) {
			const input = task();
			input.executionPlan![field] = [];
			expect(fusionTaskError(input)).toBeDefined();
			input.executionPlan![field] = ["   "];
			expect(fusionTaskError(input)).toBeDefined();
		}
		const input = task();
		input.executionPlan!.steps = Array(21).fill("step");
		expect(fusionTaskError(input)).toBeDefined();
		input.executionPlan!.steps = ["x".repeat(2001)];
		expect(fusionTaskError(input)).toBeDefined();
	});
	test("verification needs concrete checks or an explicit exclusion", () => {
		const input = task();
		input.executionPlan!.verification.checks = [];
		expect(fusionTaskError(input)).toContain("concrete checks");
		input.executionPlan!.verification.mode = "skip";
		expect(fusionTaskError(input)).toBeUndefined();
		input.executionPlan!.constraints = [];
		expect(fusionTaskError(input)).toContain("restriction");
		input.executionPlan!.constraints = ["User forbids verification"];
		input.executionPlan!.verification.checks = ["bun test"];
		expect(fusionTaskError(input)).toContain("empty checks");
	});
	test("passes decisions, restrictions, checks and visual specification verbatim", () => {
		const input = task();
		input.designSpec = "Keep #ff0077 and 12px spacing";
		const prompt = taskHandoffPrompt(input);
		expect(prompt).toContain(input.prompt);
		expect(prompt).toContain(JSON.stringify(input.executionPlan, null, 2));
		expect(prompt).toContain(input.designSpec);
		expect(prompt).toContain("Declared writable paths: .");
		input.executionPlan!.verification = { mode: "skip", checks: [] };
		expect(taskHandoffPrompt(input)).toContain("不要运行测试、构建或浏览器验证");
	});
	test("ordinary tasks do not require a structured plan", () => {
		const input = task();
		delete input.executionPlan;
		expect(taskHandoffPrompt(input)).not.toContain("Lead 执行计划");
		expect(taskHandoffPrompt(input)).toContain(input.prompt);
	});
});

const tool = (toolName: string, status: "running" | "done" | "error", output?: string): TaskStep => ({
	kind: "tool", id: "call", toolName, args: "bun test", status, output, startedAt: 1,
});
describe("Fusion execution evidence", () => {
	test("records actual command results and errors, not progress or model claims", () => {
		const evidence = new FusionExecutionEvidence();
		evidence.record(tool("bash", "running"));
		evidence.record(tool("read", "done", "file"));
		evidence.record({ kind: "message", id: "claim", text: "All tests passed", startedAt: 1 });
		expect(evidence.appendTo("Done")).toContain("No completed shell calls");
		evidence.record(tool("powershell", "done", "3 tests failed"));
		evidence.record(tool("edit", "error", "No exact match"));
		evidence.record(tool("bash", "error", "Exit code 1"));
		expect(evidence.summary()).toEqual({ observedCommands: 2, failedCommands: 1 });
		const result = evidence.appendTo("Worker report");
		expect(result).toStartWith("Worker report");
		expect(result).toContain("3 tests failed");
		expect(result).toContain("No exact match");
		expect(result).not.toContain("All tests passed");
		expect(result).toContain("tool success is not acceptance");
	});
	test("bounds evidence to the latest eight results and output tails", () => {
		const evidence = new FusionExecutionEvidence();
		for (let i = 0; i < 10; i++) evidence.record(tool("bash", "done", `result-${i}`));
		const result = evidence.appendTo("Done");
		expect(result).not.toContain("result-0");
		expect(result).not.toContain("result-1");
		expect(result).toContain("result-2");
		expect(result).toContain("result-9");
		evidence.record(tool("bash", "done", "HEAD" + "x".repeat(2000) + "TAIL"));
		expect(evidence.appendTo("Done")).not.toContain("HEAD");
		expect(evidence.appendTo("Done")).toContain("TAIL");
	});
});
