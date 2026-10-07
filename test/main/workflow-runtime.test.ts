import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { selectFastContextModel, WorkflowRuntime } from "../../src/main/workflow-runtime";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { resolveFusion } from "../../src/main/fusion-config";
import type { TaskInput, TaskStep, TaskRunResult } from "../../src/shared/workflow";

const model = (provider: string, id: string) => ({ provider, id }) as Model<Api>;
const parent = model("anthropic", "lead");
const sidekick = model("zai", "side");
const fusion = {
	config: {
		leadModelKey: "anthropic/lead", leadThinkingLevel: "high",
		sidekickModelKey: "zai/side", sidekickThinkingLevel: "medium",
	},
	lead: parent, sidekick,
} as Awaited<ReturnType<typeof resolveFusion>>;

describe("Fusion task runtime gate", () => {
	const setup = (enabled: boolean, permission: "auto" | "read-only" = "auto") => {
		const options = {
			cwd: process.cwd(), initialFusion: enabled ? fusion.config : null,
			initialMode: enabled ? "agent" : "multitask", getPermission: () => permission, debugRoot: process.cwd(),
			sessionManager: { getBranch: () => [], appendCustomEntry: () => undefined },
			modelRuntime: {}, onChange: () => undefined, onModeChange: () => undefined,
		} as unknown as ConstructorParameters<typeof WorkflowRuntime>[0];
		const runtime = new WorkflowRuntime(options);
		const session = {
			agent: {}, model: parent, setActiveToolsByName: () => undefined,
		} as unknown as AgentSession;
		runtime.attach(session);
		const gate = (args: unknown, name = "task") => session.agent.beforeToolCall!({
			toolCall: { name, id: "task-call", arguments: args }, args,
		} as Parameters<NonNullable<typeof session.agent.beforeToolCall>>[0]);
		return { runtime, gate };
	};
	test("worker handoff returns observed evidence even when the helper fails", async () => {
		for (const fails of [false, true]) {
			const { runtime } = setup(true);
			// Stub only the external model run; exercise actual task prompt/result wiring.
			const harness = runtime as unknown as {
				runHelper: (role: string, prompt: string, signal: AbortSignal, paths: string[], onStep: (step: TaskStep) => void) => Promise<string>;
				runTask: (input: TaskInput, signal: AbortSignal, onStep: (step: TaskStep) => void) => Promise<TaskRunResult>;
			};
			harness.runHelper = async (_role, prompt, _signal, _paths, onStep) => {
				expect(prompt).toContain("Lead 执行计划");
				expect(prompt).toContain("bun test regression.test.ts");
				onStep({ kind: "tool", id: "check", toolName: "bash", args: "bun test regression.test.ts",
					status: "error", output: "Regression failed", startedAt: 1, endedAt: 2 });
				if (fails) throw new Error("Model unavailable");
				return "Needs Lead review";
			};
			const input: TaskInput = { kind: "worker", description: "Fix", prompt: "Implement", writablePaths: ["."],
				executionPlan: { steps: ["Fix regression"], constraints: [], acceptanceCriteria: ["Regression passes"],
					verification: { mode: "run", checks: ["bun test regression.test.ts"] } } };
			const steps: TaskStep[] = [];
			const result = harness.runTask(input, new AbortController().signal, (step) => steps.push(step));
			if (fails) {
				await expect(result).rejects.toThrow("Regression failed");
			} else {
				const handoff = await result;
				expect(handoff.text).toContain("Regression failed");
				expect(handoff.outcome).toBe("needs_decision");
			}
			expect(steps).toHaveLength(1);
		}
	});
	test("stale direct Lead edits and commands are blocked while review and planned delegation remain available", async () => {
		const { gate } = setup(true);
		for (const name of ["write", "edit", "ast_edit", "bash", "powershell", "ssh", "custom_write",
			"grep", "find", "ls", "stat", "ast_grep", "semantic_search", "github", "web_search", "web_fetch"]) {
			const result = await gate({ path: "fusion-should-not-exist.txt", command: "echo forbidden" }, name);
			expect(result?.block, name).toBe(true);
			expect(result?.reason, name).toContain("task.executionPlan");
		}
		expect((await gate({}, "read"))?.block).not.toBe(true);
		expect((await gate({ query: "Collect root-cause evidence" }, "code_search"))?.block).not.toBe(true);
		expect((await setup(false).gate({ path: "fusion-should-not-exist.txt" }, "write"))?.block).not.toBe(true);
	});
	test("an unplanned Fusion worker is blocked before it takes ownership", async () => {
		const { runtime, gate } = setup(true);
		const result = await gate({ kind: "worker", prompt: "Fix it", writablePaths: ["."] });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("executionPlan");
		expect(runtime.state.snapshot().tasks).toHaveLength(0);
		expect(runtime.state.hasWritingTasks).toBe(false);
	});
	test("non-Fusion workers and exploration retain their existing gate", async () => {
		expect((await setup(false).gate({ kind: "worker" }))?.block).not.toBe(true);
		expect((await setup(true).gate({ kind: "explore" }))?.block).not.toBe(true);
	});
	test("a valid plan passes the gate but never bypasses read-only permission", async () => {
		const args = { kind: "worker", executionPlan: {
			steps: ["Implement decided change"], constraints: [], acceptanceCriteria: ["Regression passes"],
			verification: { mode: "run", checks: ["bun test regression.test.ts"] },
		} };
		expect((await setup(true).gate(args))?.block).not.toBe(true);
		const readOnly = setup(true, "read-only");
		// task remains available for read-only exploration; state rejects the write kind.
		expect(() => readOnly.runtime.state.startTask({
			...args, kind: "worker", description: "Fix", prompt: "Implement", writablePaths: ["."],
			executionPlan: { ...args.executionPlan, verification: { mode: "run", checks: ["bun test"] } },
		})).toThrow("read-only permission");
		expect(readOnly.runtime.state.snapshot().tasks).toHaveLength(0);
	});
});

describe("selectFastContextModel", () => {
	test("uses the Fusion Sidekick when Fusion is on", () => {
		const pick = selectFastContextModel(parent, "high", fusion);
		expect(pick.model).toBe(sidekick);
		expect(pick.requestedThinkingLevel).toBe("medium");
	});
	test("otherwise follows the session's model and thinking level", () => {
		const pick = selectFastContextModel(parent, "high", null);
		expect(pick.model).toBe(parent);
		expect(pick.requestedThinkingLevel).toBe("high");
	});
});
