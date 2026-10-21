import { describe, expect, test } from "bun:test";
import { CellProjector, projectMessages, type ProjectableMessage } from "../../src/main/agent-projection";

test("streamed text and tool output update over long persisted history without rereading message content", () => {
	let historyReads = 0;
	const history: ProjectableMessage[] = Array.from({ length: 2000 }, (_, index) => ({
		role: index % 2 ? "assistant" : "user", timestamp: index + 1,
		get content() { historyReads++; return index % 2 ? [{ type: "text", text: "historical answer" }] : "historical prompt"; },
	}));
	const projector = new CellProjector();
	projector.rebuild(history, true);
	historyReads = 0;
	for (let index = 0; index < 30; index++) {
		projector.handleEvent({ type: "message_update", message: { role: "assistant", timestamp: 3000, content: [{ type: "text", text: `live-${index}` }] } });
		expect(projector.cells().find((cell) => cell.type === "assistant" && cell.streaming)).toMatchObject({ text: `live-${index}` });
	}
	projector.handleEvent({ type: "tool_execution_start", toolCallId: "live-tool", toolName: "read", args: { path: "example.ts" } });
	projector.handleEvent({ type: "tool_execution_update", toolCallId: "live-tool", toolName: "read", args: { path: "example.ts" }, partialResult: { content: [{ type: "text", text: "partial" }] } });
	expect(projector.cells().find((cell) => cell.type === "tool")).toMatchObject({ output: "partial", status: "running" });
	expect(historyReads).toBe(0);
	const final: ProjectableMessage = { role: "assistant", timestamp: 3000, content: [{ type: "text", text: "final" }, { type: "toolCall", id: "live-tool", name: "read", arguments: { path: "example.ts" } }] };
	projector.handleEvent({ type: "message_end", message: final });
	projector.handleEvent({ type: "tool_execution_end", toolCallId: "live-tool", toolName: "read", isError: false, result: { content: [{ type: "text", text: "complete" }] } });
	projector.rebuild([...history, final, { role: "toolResult", toolCallId: "live-tool", toolName: "read", timestamp: 3001, content: [{ type: "text", text: "complete" }] }]);
	const cells = projector.cells();
	expect(cells.filter((cell) => cell.type === "assistant" && cell.text === "final")).toHaveLength(1);
	expect(cells.filter((cell) => cell.type === "tool")).toHaveLength(1);
	expect(cells.find((cell) => cell.type === "tool")).toMatchObject({ output: "complete", status: "done" });
});

describe("errored replies", () => {
	const failed: ProjectableMessage = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "Connection error.",
		content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
		timestamp: 2,
	};
	const user = (timestamp: number): ProjectableMessage => ({ role: "user", content: "hi", timestamp });
	const ok: ProjectableMessage = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hello" }], timestamp: 4 };

	test("stay visible while nothing has succeeded since", () => {
		const cells = projectMessages([user(1), failed]);
		expect(cells.find((c) => c.type === "assistant")).toMatchObject({ error: "Connection error." });
		expect(cells.find((c) => c.type === "tool")).toMatchObject({ status: "error" });
	});

	test("disappear once a later call gets through", () => {
		const cells = projectMessages([user(1), failed, user(3), ok]);
		expect(cells.map((c) => c.type)).toEqual(["user", "user", "assistant"]);
		expect(cells.some((c) => c.type === "assistant" && c.error)).toBe(false);
	});

	test("aborted replies are kept", () => {
		const aborted: ProjectableMessage = { ...failed, stopReason: "aborted", content: [] };
		const cells = projectMessages([user(1), aborted, user(3), ok]);
		expect(cells.some((c) => c.type === "assistant" && c.error === "Connection error.")).toBe(true);
	});

	test("a provider-aborted reply recovered in the same turn leaves no error or unexecuted tool row", () => {
		const aborted: ProjectableMessage = { ...failed, stopReason: "aborted" };
		const cells = projectMessages([user(1), aborted, ok]);
		expect(cells.map((cell) => cell.type)).toEqual(["user", "assistant"]);
		expect(cells.some((cell) => cell.type === "assistant" && cell.error)).toBe(false);
	});
});

function notices(projector: CellProjector) {
	return projector.cells().filter((c) => c.type === "notice").map((c) => (c.type === "notice" ? c.text : ""));
}

describe("auto-retry notices", () => {
	const start = (attempt: number) =>
		({ type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 0, errorMessage: "Connection error." }) as const;

	test("each attempt replaces the last, and a successful retry clears it", () => {
		const projector = new CellProjector();
		projector.handleEvent(start(1));
		projector.handleEvent(start(2));
		expect(notices(projector)).toEqual(["Retrying (2/3): Connection error."]);
		projector.handleEvent({ type: "auto_retry_end", success: true, attempt: 2 });
		expect(notices(projector)).toEqual([]);
	});

	test("a failed retry leaves only the final error", () => {
		const projector = new CellProjector();
		projector.handleEvent(start(3));
		projector.handleEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "Connection error." });
		expect(notices(projector)).toEqual(["Connection error."]);
	});

	test("a failed retry clears once a later call gets through", () => {
		const projector = new CellProjector();
		projector.handleEvent(start(3));
		projector.handleEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "Connection error." });
		projector.handleEvent({
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }], timestamp: 5 },
		});
		expect(notices(projector)).toEqual([]);
	});

	test("other notices are left alone", () => {
		const projector = new CellProjector();
		projector.notice("info", "hello");
		projector.handleEvent(start(1));
		projector.handleEvent({ type: "auto_retry_end", success: true, attempt: 1 });
		expect(notices(projector)).toEqual(["hello"]);
	});

	test("a final error the failed reply already shows is not repeated", () => {
		const projector = new CellProjector();
		projector.rebuild([
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "assistant", stopReason: "error", errorMessage: "429 rate limited", content: [], timestamp: 2 },
		]);
		projector.handleEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "429 rate limited" });
		expect(notices(projector)).toEqual([]);
	});
});

describe("live notices", () => {
	test("a repeated notice is kept once, at its latest", () => {
		const projector = new CellProjector();
		projector.notice("info", "81 skills loaded");
		projector.notice("info", "memory updated");
		projector.notice("info", "81 skills loaded");
		expect(notices(projector)).toEqual(["memory updated", "81 skills loaded"]);
	});

	test("sit where they happened rather than under the latest turn", () => {
		const projector = new CellProjector();
		const now = Date.now();
		projector.notice("info", "skills loaded");
		projector.rebuild([
			{ role: "user", content: "first", timestamp: now - 10_000 },
			{ role: "user", content: "second", timestamp: now + 10_000 },
		]);
		expect(projector.cells().map((c) => (c.type === "notice" ? "notice" : c.type))).toEqual(["user", "notice", "user"]);
	});
});
