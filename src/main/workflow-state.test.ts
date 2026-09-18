import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { WorkflowState, readSavedWorkflow, type WorkflowStateOptions } from "./workflow-state";
import { resolveWorkspacePath } from "./workflow-paths";
import { waitFor, workflowSandbox } from "./workflow-test-utils";
import type { WorkflowTask } from "../shared/workflow";

const question = [
	{
		id: "q",
		question: "Which approach?",
		options: [
			{ id: "yes", label: "Approve" },
			{ id: "no", label: "Decline" },
		],
	},
];
function state(
	cwd: string,
	runTask: WorkflowStateOptions["runTask"] = async () => "done",
	completed: WorkflowTask[] = [],
) {
	return new WorkflowState({
		cwd,
		getMode: () => "multitask",
		getPermission: () => "auto",
		canDelegate: () => true,
		onChange: () => {},
		runTask,
		onTaskComplete: async (task) => {
			completed.push(task);
		},
	});
}
describe("workflow control state", () => {
	test("rejects invalid visual specifications before starting a worker", () => {
		const sandbox = workflowSandbox();
		const flow = state(sandbox.cwd);
		try {
			const task = { description: "Design", prompt: "Implement", kind: "worker" as const, writablePaths: ["page.html"] };
			for (const designSpec of [" ", "x".repeat(16001), 123]) {
				expect(() => flow.startTask({ ...task, designSpec: designSpec as string })).toThrow("visual design specification");
			}
			expect(flow.snapshot().tasks).toHaveLength(0);
		} finally { flow.dispose(); sandbox.cleanup(); }
	});
	test("validates question ids and choices; explicit cancellation clears the request", async () => {
		const sandbox = workflowSandbox();
		const flow = state(sandbox.cwd);
		try {
			const response = flow.ask(question, "Question");
			const id = flow.snapshot().request!.id;
			expect(() => flow.answer({ requestId: "stale", answers: {} })).toThrow();
			expect(() =>
				flow.answer({ requestId: id, answers: { q: { optionId: "invented" } } }),
			).toThrow();
			flow.answer({ requestId: id, cancelled: true, answers: {} });
			expect((await response).cancelled).toBe(true);
			expect(flow.snapshot().request).toBeNull();
		} finally {
			flow.dispose();
			sandbox.cleanup();
		}
	});
	test("mode approval cannot be spoofed with free text and abort releases pending input", async () => {
		const sandbox = workflowSandbox();
		const flow = state(sandbox.cwd);
		const abort = new AbortController();
		try {
			const response = flow.ask(question, "Confirm", abort.signal, "mode-switch");
			const id = flow.snapshot().request!.id;
			expect(() => flow.answer({ requestId: id, answers: { q: { text: "yes" } } })).toThrow();
			const rejected = response.catch((error: Error) => error);
			abort.abort();
			expect(((await rejected) as Error).message).toContain("cancelled");
			expect(flow.hasPendingQuestion).toBe(false);
		} finally {
			flow.dispose();
			sandbox.cleanup();
		}
	});
	test("todo state is bounded, validated, and survives restore", () => {
		const sandbox = workflowSandbox();
		const flow = state(sandbox.cwd);
		try {
			flow.writeTodos([{ id: "a", text: "Review changes", status: "in_progress" }]);
			expect(readSavedWorkflow(flow.saved())?.todos[0].status).toBe("in_progress");
			expect(() => flow.writeTodos([{ id: "a", text: "x", status: "fake" }])).toThrow();
			expect(() =>
				flow.writeTodos([
					{ id: "a", text: "x", status: "pending" },
					{ id: "a", text: "y", status: "pending" },
				]),
			).toThrow();
		} finally {
			flow.dispose();
			sandbox.cleanup();
		}
	});
	test("caps parallelism and prevents overlapping or escaped worker writes", async () => {
		const sandbox = workflowSandbox();
		const flow = state(
			sandbox.cwd,
			(_, signal) =>
				new Promise((resolve) => {
					if (signal.aborted) resolve("cancelled");
					else signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
				}),
		);
		try {
			const input = {
				description: "Work",
				prompt: "Change a file",
				kind: "worker" as const,
				writablePaths: ["src"],
			};
			flow.startTask(input);
			expect(() => flow.startTask({ ...input, writablePaths: ["src/nested/file.ts"] })).toThrow(
				"overlap",
			);
			expect(() => flow.startTask({ ...input, writablePaths: ["../outside"] })).toThrow("outside");
			expect(() => flow.assertParentWrite("src/file.ts")).toThrow("owns");
			for (let i = 0; i < 3; i++) flow.startTask({ ...input, kind: "explore", writablePaths: [] });
			expect(() => flow.startTask({ ...input, kind: "explore", writablePaths: [] })).toThrow(
				"four",
			);
			flow.abortAll();
			await flow.whenSettled();
			expect(flow.snapshot().tasks.every((task) => task.status === "cancelled")).toBe(true);
		} finally {
			flow.dispose();
			await flow.whenSettled();
			sandbox.cleanup();
		}
	});
	test("a cancelled worker leaves neither reasoning nor a tool call still open", async () => {
		const sandbox = workflowSandbox();
		const flow = state(
			sandbox.cwd,
			(_, signal, onStep) =>
				new Promise((resolve) => {
					// A worker interrupted mid-thought and mid-call: both steps are open
					// and nothing else is coming to close them.
					onStep({ kind: "thinking", id: "th", text: "weighing", startedAt: Date.now() });
					onStep({
						kind: "tool",
						id: "call",
						toolName: "read",
						args: '{"path":"a.ts"}',
						status: "running",
						startedAt: Date.now(),
					});
					signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
				}),
		);
		try {
			const task = flow.startTask({
				description: "Scout",
				prompt: "Inspect",
				kind: "explore",
				writablePaths: [],
			});
			await waitFor(() => flow.snapshot().tasks[0]?.steps.length === 2);
			flow.cancelTask(task.id);
			await flow.whenSettled();

			const [settled] = flow.snapshot().tasks;
			expect(settled.status).toBe("cancelled");
			const [thinking, call] = settled.steps;
			// A spinner that never stops would say the worker is still going.
			expect(thinking.kind === "thinking" && thinking.endedAt).toBeGreaterThan(0);
			expect(call.kind === "tool" && call.status).toBe("error");
		} finally {
			flow.dispose();
			await flow.whenSettled();
			sandbox.cleanup();
		}
	});
	test("resolves directory junctions before accepting write scopes", () => {
		const sandbox = workflowSandbox();
		const outside = join(sandbox.root, "outside");
		mkdirSync(outside);
		try {
			symlinkSync(
				outside,
				join(sandbox.cwd, "linked"),
				process.platform === "win32" ? "junction" : "dir",
			);
			expect(() => resolveWorkspacePath(sandbox.cwd, "linked/file.txt")).toThrow("outside");
		} finally {
			sandbox.cleanup();
		}
	});
	test("completion is delivered once; restored running workers are interrupted, not resumed", async () => {
		const sandbox = workflowSandbox();
		const completed: WorkflowTask[] = [];
		const flow = state(sandbox.cwd, async () => "evidence", completed);
		try {
			flow.startTask({
				description: "Inspect",
				prompt: "Inspect files",
				kind: "explore",
				writablePaths: [],
			});
			const saved = flow.saved();
			expect(readSavedWorkflow(saved)?.tasks[0].status).toBe("cancelled");
			await flow.whenSettled();
			expect(completed).toHaveLength(1);
			expect(completed[0].result).toBe("evidence");
		} finally {
			flow.dispose();
			await flow.whenSettled();
			sandbox.cleanup();
		}
	});
});
