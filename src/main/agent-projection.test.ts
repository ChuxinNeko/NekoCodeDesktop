import { describe, expect, test } from "bun:test";
import {
	CellProjector,
	parseSlashCommand,
	projectMessages,
	toolOutputText,
	type ProjectableMessage,
} from "./agent-projection";

const userMsg = (text: string, timestamp = 1000): ProjectableMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});

const assistantMsg = (
	text: string,
	thinking = "",
	timestamp = 2000,
): ProjectableMessage => ({
	role: "assistant",
	content: [
		...(thinking ? [{ type: "thinking" as const, thinking }] : []),
		{ type: "text" as const, text },
	],
	stopReason: "stop",
	timestamp,
});

const assistantWithToolCall = (
	toolCallId: string,
	name: string,
	args: Record<string, unknown>,
	timestamp = 2000,
): ProjectableMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
	stopReason: "toolUse",
	timestamp,
});

const toolResultMsg = (
	toolCallId: string,
	output: string,
	isError = false,
	timestamp = 3000,
): ProjectableMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "bash",
	content: [{ type: "text", text: output }],
	isError,
	timestamp,
});

describe("projectMessages", () => {
	test("projects persisted user/assistant/toolResult messages", () => {
		const cells = projectMessages([
			userMsg("hello"),
			assistantMsg("hi there", "let me think"),
			toolResultMsg("tc1", "file contents"),
		]);
		expect(cells.map((c) => c.type)).toEqual(["user", "assistant", "tool"]);
		expect(cells[0]).toMatchObject({ type: "user", text: "hello" });
		expect(cells[1]).toMatchObject({
			type: "assistant",
			text: "hi there",
			thinking: "let me think",
			streaming: false,
		});
		expect(cells[2]).toMatchObject({
			type: "tool",
			toolCallId: "tc1",
			toolName: "bash",
			output: "file contents",
			status: "done",
		});
	});

	test("produces identical ids for identical input", () => {
		const messages = [
			userMsg("hello"),
			assistantWithToolCall("tc1", "bash", { command: "ls" }),
			toolResultMsg("tc1", "out"),
			assistantMsg("done"),
		];
		const a = projectMessages(messages);
		const b = projectMessages(messages);
		expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
		expect(a.map((c) => c.id)).toEqual([
			"user-1000-0",
			"tool-tc1",
			"assistant-2000-3",
		]);
	});

	test("marks assistant errors and skips empty messages", () => {
		const cells = projectMessages([
			{
				role: "assistant",
				content: [{ type: "text", text: "" }],
				stopReason: "error",
				errorMessage: "rate limited",
				timestamp: 1,
			},
			{ role: "user", content: [{ type: "text", text: "  " }], timestamp: 2 },
		]);
		expect(cells).toHaveLength(1);
		expect(cells[0]).toMatchObject({ type: "assistant", error: "rate limited" });
	});

	test("assistant toolCall creates pending tool cell updated in place by toolResult", () => {
		const messages = [
			userMsg("run ls"),
			assistantWithToolCall("tc1", "bash", { command: "ls" }),
			toolResultMsg("tc1", "a\nb"),
		];
		const cells = projectMessages(messages);
		expect(cells.filter((c) => c.type === "tool")).toHaveLength(1);
		const tool = cells[1];
		expect(tool).toMatchObject({
			id: "tool-tc1",
			type: "tool",
			toolCallId: "tc1",
			toolName: "bash",
			args: { command: "ls" },
			output: "a\nb",
			status: "done",
		});
	});

	test("toolCall with missing arguments normalizes to {}", () => {
		const cells = projectMessages([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t9", name: "read" }],
				timestamp: 5,
			},
		]);
		expect(cells[0]).toMatchObject({
			type: "tool",
			toolCallId: "t9",
			args: {},
			status: "pending",
		});
	});

	test("projects bashExecution as tool cell and custom as notice", () => {
		const cells = projectMessages([
			{
				role: "bashExecution",
				command: "ls",
				output: "a\nb",
				exitCode: 0,
				timestamp: 1,
			},
			{
				role: "custom",
				customType: "notice",
				content: "heads up",
				display: true,
				timestamp: 2,
			},
		]);
		expect(cells[0]).toMatchObject({
			type: "tool",
			toolName: "bash",
			output: "a\nb",
			status: "done",
		});
		expect(cells[1]).toMatchObject({ type: "notice", text: "heads up" });
	});
});

describe("CellProjector streaming", () => {
	test("streaming assistant updates in place without new cells", () => {
		const p = new CellProjector();
		p.rebuild([userMsg("q")]);
		p.handleEvent({
			type: "message_start",
			message: { role: "assistant", content: [], timestamp: 2 },
		});
		p.handleEvent({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				timestamp: 2,
			},
		});
		p.handleEvent({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial done" }],
				timestamp: 2,
			},
		});
		const cells = p.cells();
		expect(cells.map((c) => c.type)).toEqual(["user", "assistant"]);
		expect(cells[1]).toMatchObject({
			type: "assistant",
			text: "partial done",
			streaming: true,
		});
		expect(cells[1].id).toBe("assistant-stream-2");
		p.handleEvent({
			type: "message_end",
			message: assistantMsg("partial done", "", 2),
		});
		p.rebuild([userMsg("q"), assistantMsg("partial done", "", 2)]);
		const final = p.cells();
		expect(final.map((c) => c.type)).toEqual(["user", "assistant"]);
		expect(final[1]).toMatchObject({ streaming: false, text: "partial done" });
	});

	test("execution overlay overrides persisted pending tool in place", () => {
		const p = new CellProjector();
		// Persisted transcript already has the assistant toolCall (pending).
		p.rebuild([userMsg("run ls"), assistantWithToolCall("tc1", "bash", { command: "ls" })]);
		expect(p.cells()[1]).toMatchObject({ type: "tool", status: "pending" });
		p.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "bash",
			args: { command: "ls" },
		});
		let cells = p.cells();
		expect(cells.filter((c) => c.type === "tool")).toHaveLength(1);
		expect(cells[1]).toMatchObject({ type: "tool", status: "running" });
		p.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "a\nb" }] },
			isError: false,
		});
		cells = p.cells();
		expect(cells[1]).toMatchObject({ status: "done", output: "a\nb" });
		// toolResult lands in the transcript; overlay is folded back (args kept).
		p.rebuild([
			userMsg("run ls"),
			assistantWithToolCall("tc1", "bash", { command: "ls" }),
			toolResultMsg("tc1", "a\nb"),
		]);
		cells = p.cells();
		expect(cells.filter((c) => c.type === "tool")).toHaveLength(1);
		expect(cells[1]).toMatchObject({
			status: "done",
			output: "a\nb",
			args: { command: "ls" },
		});
	});

	test("tool_execution_start upserts rather than duplicating", () => {
		const p = new CellProjector();
		p.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "bash",
			args: { command: "ls" },
		});
		p.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "bash",
			args: { command: "ls -la" },
		});
		const cells = p.cells();
		expect(cells.filter((c) => c.type === "tool")).toHaveLength(1);
		expect(cells[0]).toMatchObject({ args: { command: "ls -la" } });
	});

	test("auto_retry events become notices", () => {
		const p = new CellProjector();
		p.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "overloaded",
		});
		p.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "still overloaded",
		});
		const notices = p.cells().filter((c) => c.type === "notice");
		expect(notices).toHaveLength(2);
		expect(notices[0]).toMatchObject({ level: "warning" });
		expect(notices[1]).toMatchObject({ level: "error", text: "still overloaded" });
	});
});

describe("parseSlashCommand", () => {
	test("parses command and args", () => {
		expect(parseSlashCommand("/model anthropic/claude")).toEqual({
			command: "model",
			args: "anthropic/claude",
		});
		expect(parseSlashCommand("/new")).toEqual({ command: "new", args: "" });
		expect(parseSlashCommand("  /thinking high  ")).toEqual({
			command: "thinking",
			args: "high",
		});
	});

	test("returns null for non-slash input", () => {
		expect(parseSlashCommand("hello /model")).toBeNull();
		expect(parseSlashCommand("")).toBeNull();
	});
});

describe("toolOutputText", () => {
	test("extracts text content and handles junk", () => {
		expect(
			toolOutputText({ content: [{ type: "text", text: "out" }] }),
		).toBe("out");
		expect(toolOutputText("raw")).toBe("raw");
		expect(toolOutputText(undefined)).toBe("");
		expect(toolOutputText({ content: [] })).toBe("");
	});
});
