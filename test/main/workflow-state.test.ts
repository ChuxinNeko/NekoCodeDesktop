import { describe, expect, test } from "bun:test";
import { MAX_FINISHED_EXPLORERS } from "../../src/shared/workflow";
import { WorkflowState } from "../../src/main/workflow-state";

function state() {
	let changes = 0;
	const workflow = new WorkflowState({
		cwd: process.cwd(),
		getMode: () => "agent",
		getPermission: () => "auto",
		canDelegate: () => true,
		onChange: () => changes++,
		onTaskComplete: async () => {},
		runTask: async () => "",
	});
	return { workflow, changes: () => changes };
}

describe("queued questions", () => {
	const questions = [{ id: "reason", question: "Why stop?", options: [] }];
	test("waits behind an existing question without replacing it", async () => {
		const { workflow } = state();
		const first = workflow.ask(questions, "First");
		const queued = workflow.askQueued(questions, "Stop reason");
		const request = workflow.snapshot().request!;
		expect(request.title).toBe("First");
		workflow.answer({ requestId: request.id, answers: { reason: { text: "first answer" } } });
		await first;
		await new Promise((resolve) => setTimeout(resolve, 0));
		const next = workflow.snapshot().request!;
		expect(next.title).toBe("Stop reason");
		workflow.answer({ requestId: next.id, answers: { reason: { text: "too slow" } } });
		expect((await queued).answers.reason.text).toBe("too slow");
		expect(workflow.snapshot().request).toBeNull();
	});
	test("cancelling a queued inquiry does not cancel the existing question", async () => {
		const { workflow } = state();
		const first = workflow.ask(questions, "First");
		const abort = new AbortController();
		const queued = workflow.askQueued(questions, "Stop reason", abort.signal);
		abort.abort();
		await expect(queued).rejects.toThrow("Question cancelled");
		const request = workflow.snapshot().request!;
		expect(request.title).toBe("First");
		workflow.answer({ requestId: request.id, answers: {}, cancelled: true });
		await first;
		expect(workflow.snapshot().request).toBeNull();
	});
});

describe("explorer runs", () => {
	test("appear in the snapshot live, fold steps by id, and settle open steps when they end", () => {
		const { workflow, changes } = state();
		expect(workflow.snapshot().explorers).toBeUndefined();
		const run = workflow.startExplorer("where is auth handled", "anthropic/claude-haiku");
		run.step({ kind: "tool", id: "t1", toolName: "grep", args: "auth", status: "running", startedAt: 1 });
		run.step({ kind: "tool", id: "t1", toolName: "grep", args: "auth", status: "done", startedAt: 1, endedAt: 2 });
		run.step({ kind: "tool", id: "t2", toolName: "read", args: "src/auth.ts", status: "running", startedAt: 3 });
		let [explorer] = workflow.snapshot().explorers ?? [];
		expect(explorer).toMatchObject({ query: "where is auth handled", model: "anthropic/claude-haiku", status: "running" });
		expect(explorer.steps).toHaveLength(2);

		run.finish("completed");
		run.finish("failed");
		run.step({ kind: "tool", id: "t3", toolName: "ls", args: ".", status: "running", startedAt: 4 });
		[explorer] = workflow.snapshot().explorers ?? [];
		expect(explorer.status).toBe("completed");
		expect(explorer.steps).toHaveLength(2);
		expect(explorer.steps[1]).toMatchObject({ status: "done" });
		expect(changes()).toBeGreaterThan(0);
	});

	test("keep every running run and only the latest finished ones", () => {
		const { workflow } = state();
		const live = workflow.startExplorer("still going");
		for (let i = 0; i < MAX_FINISHED_EXPLORERS + 3; i++) workflow.startExplorer(`q${i}`).finish("completed");
		const explorers = workflow.snapshot().explorers ?? [];
		expect(explorers.filter((run) => run.status !== "running")).toHaveLength(MAX_FINISHED_EXPLORERS);
		expect(explorers.some((run) => run.query === "still going" && run.status === "running")).toBe(true);
		live.finish("cancelled");
	});
});
