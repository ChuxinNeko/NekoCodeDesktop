import { describe, expect, test } from "bun:test";
import type { TaskInput, TaskStep } from "../../src/shared/workflow";
import { fusionTaskError, taskHandoffPrompt, FusionExecutionEvidence } from "../../src/main/fusion-handoff";

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
