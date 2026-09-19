import { describe, expect, test } from "bun:test";
import {
	CellProjector,
	expandNekoSlashAlias,
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
	details?: unknown,
): ProjectableMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "bash",
	content: [{ type: "text", text: output }],
	isError,
	details,
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

	test("a persisted toolResult carries its details onto the tool cell", () => {
		const details = { diff: "-1 old line\n+1 new line" };
		const cells = projectMessages([
			userMsg("edit it"),
			assistantWithToolCall("tc1", "edit", { path: "a.ts" }),
			toolResultMsg("tc1", "replaced", false, 3000, details),
		]);
		expect(cells[1]).toMatchObject({ type: "tool", status: "done", details });
	});

	test("a standalone persisted toolResult keeps its details too", () => {
		const details = { diff: "+1 written" };
		const cells = projectMessages([
			userMsg("go"),
			toolResultMsg("tc9", "done", false, 3000, details),
		]);
		expect(cells[1]).toMatchObject({ type: "tool", toolCallId: "tc9", details });
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

describe("expanded skill commands in user messages", () => {
	test("a design expansion projects as the /design command, not the skill body", () => {
		const expanded =
			'<skill name="design" location="D:\\skills\\design\\SKILL.md">\n' +
			"References are relative...\n\nFULL PRIVATE SKILL BODY\n</skill>\n\n" +
			"写一个html来介绍一下你自己";
		const cells = projectMessages([userMsg(expanded)]);
		expect(cells).toHaveLength(1);
		expect(cells[0]).toMatchObject({
			type: "user",
			text: "/design 写一个html来介绍一下你自己",
		});
		expect((cells[0] as { text: string }).text).not.toContain(
			"FULL PRIVATE SKILL BODY",
		);
	});

	test("a design expansion without args projects as bare /design", () => {
		const expanded =
			'<skill name="design" location="D:\\skills\\design\\SKILL.md">\n' +
			"References are relative...\n\nFULL PRIVATE SKILL BODY\n</skill>";
		const cells = projectMessages([userMsg(expanded)]);
		expect(cells).toHaveLength(1);
		expect(cells[0]).toMatchObject({ type: "user", text: "/design" });
	});

	test("another skill expansion projects as /skill:<name>", () => {
		const expanded =
			'<skill name="code-review" location="D:\\skills\\code-review\\SKILL.md">\n' +
			"References are relative...\n\nFULL PRIVATE SKILL BODY\n</skill>\n\n" +
			"review this";
		const cells = projectMessages([userMsg(expanded)]);
		expect(cells).toHaveLength(1);
		expect(cells[0]).toMatchObject({
			type: "user",
			text: "/skill:code-review review this",
		});
	});

	test("a clone-website expansion projects as the /clone-website command", () => {
		const expanded =
			'<skill name="clone-website" location="D:\\skills\\clone-website\\SKILL.md">\n' +
			"References are relative...\n\nFULL PRIVATE SKILL BODY\n</skill>\n\n" +
			"https://example.com";
		const cells = projectMessages([userMsg(expanded)]);
		expect(cells).toHaveLength(1);
		expect(cells[0]).toMatchObject({
			type: "user",
			text: "/clone-website https://example.com",
		});
		expect((cells[0] as { text: string }).text).not.toContain(
			"FULL PRIVATE SKILL BODY",
		);
	});
});

describe("turn usage", () => {
	const usage = (input: number, output: number) => ({
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { total: 0.001 },
	});

	const call = (
		text: string,
		tokens: { input: number; output: number },
		timestamp: number,
	): ProjectableMessage => ({
		...assistantMsg(text, "", timestamp),
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage: usage(tokens.input, tokens.output),
	});

	/** An assistant message that only calls a tool renders no cell of its own. */
	const toolCall = (id: string, tokens: { input: number; output: number }, timestamp: number) => ({
		...assistantWithToolCall(id, "bash", { command: "ls" }, timestamp),
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage: usage(tokens.input, tokens.output),
	});

	test("sums the whole turn onto its last visible message", () => {
		const cells = projectMessages([
			userMsg("go"),
			toolCall("tc1", { input: 100, output: 20 }, 2000),
			toolResultMsg("tc1", "ok"),
			call("done", { input: 300, output: 80 }, 4000),
		]);
		const assistants = cells.filter((c) => c.type === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].type === "assistant" && assistants[0].usage).toMatchObject({
			calls: 2,
			input: 400,
			output: 100,
			totalTokens: 500,
			costUsd: 0.002,
		});
	});

	test("leaves every earlier message in the turn without a panel", () => {
		const cells = projectMessages([
			userMsg("go"),
			call("thinking out loud", { input: 100, output: 20 }, 2000),
			call("done", { input: 300, output: 80 }, 4000),
		]);
		const usages = cells
			.filter((c) => c.type === "assistant")
			.map((c) => (c.type === "assistant" ? c.usage : undefined));
		expect(usages).toHaveLength(2);
		expect(usages[0]).toBeUndefined();
		expect(usages[1]).toMatchObject({ calls: 2, totalTokens: 500 });
	});

	test("keeps turns apart", () => {
		const cells = projectMessages([
			userMsg("first", 1000),
			call("a", { input: 100, output: 10 }, 2000),
			userMsg("second", 3000),
			call("b", { input: 200, output: 20 }, 4000),
		]);
		const usages = cells
			.filter((c) => c.type === "assistant")
			.map((c) => (c.type === "assistant" ? c.usage?.totalTokens : undefined));
		expect(usages).toEqual([110, 220]);
	});

	test("withholds the running turn's total until the agent stops", () => {
		const messages = [userMsg("go"), call("working", { input: 100, output: 10 }, 2000)];
		const running = projectMessages(messages, undefined, undefined, true);
		expect(running[1].type === "assistant" && running[1].usage).toBeUndefined();
		const settled = projectMessages(messages, undefined, undefined, false);
		expect(settled[1].type === "assistant" && settled[1].usage).toMatchObject({ calls: 1 });
	});

	test("reports nothing rather than a turn of zeroes", () => {
		const [, plain] = projectMessages([userMsg("go"), assistantMsg("done")]);
		expect(plain.type === "assistant" && plain.usage).toBeUndefined();
	});

	test("only names a response model when it is not the one requested", () => {
		const served = { ...call("done", { input: 1, output: 1 }, 2000), responseModel: "opus-4-8-x" };
		const [, cell] = projectMessages([userMsg("go"), served]);
		expect(cell.type === "assistant" && cell.usage?.responseModel).toBe("opus-4-8-x");
		const same = { ...call("done", { input: 1, output: 1 }, 2000), responseModel: "claude-opus-4-8" };
		const [, plain] = projectMessages([userMsg("go"), same]);
		expect(plain.type === "assistant" && plain.usage?.responseModel).toBeUndefined();
	});

	test("times the turn end to end, and the calls inside it separately", () => {
		const projector = new CellProjector();
		const first = toolCall("tc1", { input: 100, output: 20 }, 2000);
		const second = call("done", { input: 300, output: 80 }, 4000);
		for (const message of [first, second]) {
			projector.handleEvent({ type: "message_start", message });
			projector.handleEvent({ type: "message_end", message });
		}
		projector.rebuild([userMsg("go"), first, toolResultMsg("tc1", "ok"), second], false);
		const cell = projector.cells().find((c) => c.type === "assistant");
		const turnUsage = cell?.type === "assistant" ? cell.usage : undefined;
		expect(turnUsage?.calls).toBe(2);
		expect(turnUsage?.durationMs).toBeGreaterThanOrEqual(0);
		expect(turnUsage?.modelMs).toBeLessThanOrEqual(turnUsage?.durationMs ?? 0);
	});

	test("closes an aborted turn's timing so it still reports a duration", () => {
		const projector = new CellProjector();
		const message = call("done", { input: 100, output: 20 }, 2000);
		projector.handleEvent({ type: "message_start", message });
		projector.handleEvent({ type: "agent_end" });
		projector.rebuild([userMsg("go"), message], false);
		const cell = projector.cells().find((c) => c.type === "assistant");
		expect(cell?.type === "assistant" && cell.usage?.durationMs).toBeGreaterThanOrEqual(0);
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

	test("tool_execution_update and end keep result details on the live cell", () => {
		const p = new CellProjector();
		p.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "edit",
			args: { path: "a.ts" },
		});
		p.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc1",
			toolName: "edit",
			args: { path: "a.ts" },
			partialResult: {
				content: [{ type: "text", text: "working" }],
				details: { diff: "+1 partial" },
			},
		});
		expect(p.cells()[0]).toMatchObject({ details: { diff: "+1 partial" } });
		p.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "replaced" }],
				details: { diff: "-1 a\n+1 b" },
			},
			isError: false,
		});
		expect(p.cells()[0]).toMatchObject({ status: "done", details: { diff: "-1 a\n+1 b" } });
	});

	test("overlay details merge onto a persisted pending tool cell", () => {
		const p = new CellProjector();
		p.rebuild([userMsg("go"), assistantWithToolCall("tc1", "edit", { path: "a.ts" })]);
		p.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "edit",
			args: { path: "a.ts" },
		});
		p.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "replaced" }],
				details: { diff: "+1 merged" },
			},
			isError: false,
		});
		expect(p.cells()[1]).toMatchObject({ status: "done", details: { diff: "+1 merged" } });
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

describe("expandNekoSlashAlias", () => {
	test("expands /design into the built-in skill command", () => {
		expect(expandNekoSlashAlias("/design")).toBe("/skill:design");
		expect(expandNekoSlashAlias("/design a finance dashboard")).toBe(
			"/skill:design a finance dashboard",
		);
		expect(expandNekoSlashAlias("  /design   a finance dashboard  ")).toBe(
			"/skill:design a finance dashboard",
		);
	});

	test("expands /clone-website into the built-in skill command", () => {
		expect(expandNekoSlashAlias("/clone-website https://example.com")).toBe(
			"/skill:clone-website https://example.com",
		);
		expect(
			expandNekoSlashAlias(
				"/clone-website https://example.com https://example.com/about",
			),
		).toBe("/skill:clone-website https://example.com https://example.com/about");
		expect(expandNekoSlashAlias("  /clone-website   https://example.com  ")).toBe(
			"/skill:clone-website https://example.com",
		);
	});

	test("leaves other input unchanged", () => {
		expect(expandNekoSlashAlias("/design-system")).toBe("/design-system");
		expect(expandNekoSlashAlias("/clone-website-extras")).toBe(
			"/clone-website-extras",
		);
		expect(expandNekoSlashAlias("hello /design")).toBe("hello /design");
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
