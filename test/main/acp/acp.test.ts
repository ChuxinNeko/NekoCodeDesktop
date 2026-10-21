import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCell, TurnUsage } from "../../../src/shared/agent";
import { AcpConnection, AcpRpcError, AUTH_REQUIRED, METHOD_NOT_FOUND, type AcpTransport } from "../../../src/main/acp/connection";
import { AcpProjection, mapToolCall, MODE_CONFIG_ID, turnUsageFromAcp } from "../../../src/main/acp/projection";
import { AcpSession } from "../../../src/main/acp/session";
import type { AcpSessionSnapshot } from "../../../src/shared/acp";
import { AcpService, parseHistoryPage } from "../../../src/main/acp/service";
import { AcpConfigStore } from "../../../src/main/acp/config-store";
import { agentProxyEnv, BUILTIN_ACP_AGENTS, type AcpAgentDefinition } from "../../../src/main/acp/agents";
import type { AcpAuthPlan } from "../../../src/main/acp/auth";
import { TokenStatsService } from "../../../src/main/token-stats";

type Message = Record<string, unknown>;

/** Stands in for an agent process; the test plays the agent's side by hand. */
class FakeTransport implements AcpTransport {
	sent: Message[] = [];
	closed = false;
	private messageListener: ((message: unknown) => void) | null = null;
	private closeListener: ((reason: string) => void) | null = null;
	/** Answers our requests the way the scripted agent would. */
	responder: ((message: Message) => void) | null = null;

	async send(message: object): Promise<void> {
		if (this.closed) throw new Error("closed");
		this.sent.push(message as Message);
		queueMicrotask(() => this.responder?.(message as Message));
	}
	onMessage(listener: (message: unknown) => void): void {
		this.messageListener = listener;
	}
	onClose(listener: (reason: string) => void): void {
		this.closeListener = listener;
	}
	close(): void {
		this.closed = true;
	}
	deliver(message: unknown): void {
		this.messageListener?.(message);
	}
	die(reason: string): void {
		this.closed = true;
		this.closeListener?.(reason);
	}
	reply(id: unknown, result: unknown): void {
		this.deliver({ jsonrpc: "2.0", id, result });
	}
	update(sessionId: string, update: Message): void {
		this.deliver({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AcpConnection", () => {
	test("matches responses to requests and surfaces RPC errors", async () => {
		const transport = new FakeTransport();
		const connection = new AcpConnection(transport);
		const first = connection.request("initialize", { protocolVersion: 1 });
		const second = connection.request("session/new", {});
		transport.reply(1, { protocolVersion: 1 });
		transport.deliver({ jsonrpc: "2.0", id: 2, error: { code: AUTH_REQUIRED, message: "auth" } });
		expect(await first).toEqual({ protocolVersion: 1 });
		const error = await second.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(AcpRpcError);
		expect((error as AcpRpcError).code).toBe(AUTH_REQUIRED);
	});

	test("an error's detail in data is part of its message", async () => {
		const transport = new FakeTransport();
		const connection = new AcpConnection(transport);
		const pending = connection.request("session/new", {});
		transport.deliver({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32603, message: "Internal error", data: { details: "workspace routing discovery unauthorized (401)" } },
		});
		expect(await pending.catch((error: Error) => error.message)).toBe(
			"Internal error: workspace routing discovery unauthorized (401)",
		);
	});

	test("answers agent requests, including string ids and unknown methods", async () => {
		const transport = new FakeTransport();
		const connection = new AcpConnection(transport);
		connection.onRequest(async (method) => {
			if (method === "ping") return { pong: true };
			throw new AcpRpcError(METHOD_NOT_FOUND, "nope");
		});
		transport.deliver({ jsonrpc: "2.0", id: "a", method: "ping", params: {} });
		transport.deliver({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: {} });
		await tick();
		expect(transport.sent).toEqual([
			{ jsonrpc: "2.0", id: "a", result: { pong: true } },
			{ jsonrpc: "2.0", id: 7, error: { code: METHOD_NOT_FOUND, message: "nope" } },
		]);
	});

	test("rejects everything in flight when the process dies", async () => {
		const transport = new FakeTransport();
		const connection = new AcpConnection(transport);
		const pending = connection.request("session/prompt", {});
		const reasons: string[] = [];
		connection.onClose((reason) => reasons.push(reason));
		transport.die("exited with code 1");
		expect(await pending.catch((error: Error) => error.message)).toBe("exited with code 1");
		expect(reasons).toEqual(["exited with code 1"]);
		expect(await connection.request("x").catch((error: Error) => error.message)).toBe("exited with code 1");
	});
});

describe("AcpProjection", () => {
	const clock = () => 1000;

	test("streams thinking and answer into one reply, and splits on a new message", () => {
		const projection = new AcpProjection(clock);
		projection.addUserPrompt("hi");
		projection.apply({ sessionUpdate: "agent_thought_chunk", messageId: "rs_1", content: { type: "text", text: "Plan" } });
		projection.apply({ sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "I'll" } });
		projection.apply({ sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: " run it." } });
		projection.apply({ sessionUpdate: "agent_message_chunk", messageId: "msg_2", content: { type: "text", text: "DONE" } });
		const [, first, second] = projection.cells as Array<Extract<AgentCell, { type: "assistant" }>>;
		expect(first).toMatchObject({ type: "assistant", thinking: "Plan", text: "I'll run it.", streaming: false });
		expect(second).toMatchObject({ type: "assistant", text: "DONE", streaming: true });
	});

	test("turns Codex's exec tool call into a bash row that settles on update", () => {
		const projection = new AcpProjection(clock);
		projection.apply({
			sessionUpdate: "tool_call",
			toolCallId: "exec-1",
			status: "in_progress",
			kind: "execute",
			title: "echo hi > probe.txt",
			content: [{ type: "terminal", terminalId: "exec-1" }],
			rawInput: { command: "echo hi > probe.txt", cwd: "C:\\tmp" },
		});
		projection.apply({
			sessionUpdate: "tool_call_update",
			toolCallId: "exec-1",
			status: "completed",
			rawOutput: { formatted_output: "", exit_code: 0 },
		});
		expect(projection.cells).toHaveLength(1);
		expect(projection.cells[0]).toMatchObject({
			type: "tool",
			toolName: "bash",
			args: { command: "echo hi > probe.txt" },
			output: "",
			status: "done",
		});
	});

	test("shows an MCP tool call as that tool, with its arguments and result", () => {
		// The shape Codex reports for a call to NekoCode's own tool server.
		expect(
			mapToolCall({
				toolCallId: "exec-1",
				kind: "execute",
				title: "mcp.nekocode.browser_screenshot",
				status: "completed",
				rawInput: { server: "nekocode", tool: "browser_screenshot", arguments: { fullPage: true } },
				rawOutput: { result: { content: [{ type: "text", text: "Saved shot.png" }, { type: "image", data: "AAAA", mimeType: "image/png" }] } },
			}),
		).toEqual({ toolName: "browser_screenshot", args: { fullPage: true }, output: "Saved shot.png\n[图片]", status: "done" });
	});

	test("an approval review shows its verdict, not its bookkeeping ids", () => {
		expect(
			mapToolCall({
				toolCallId: "guardian_assessment:1",
				kind: "think",
				title: "Guardian Review",
				status: "completed",
				rawInput: { threadId: "t", turnId: "u" },
				content: [{ type: "content", content: { type: "text", text: "Status: Approved\nAction: MCP browser_navigate\nRisk: low" } }],
			}),
		).toMatchObject({ toolName: "Guardian Review", args: { summary: "Status: Approved" }, status: "done" });
	});

	test("a patch across several files is a card per file, each told its own diff", () => {
		const projection = new AcpProjection(clock);
		projection.setDiffer((oldText, newText) => `-1 ${oldText.trim()}\n+1 ${newText.trim()}`);
		// Codex's apply_patch: whole files before and after, CRLF and all.
		projection.apply({
			sessionUpdate: "tool_call",
			toolCallId: "patch-1",
			kind: "edit",
			status: "in_progress",
			content: [
				{ type: "diff", path: "C:\\p\\a.txt", oldText: "one\r\n", newText: "ONE\r\n" },
				{ type: "diff", path: "C:\\p\\new.txt", oldText: null, newText: "hello\n" },
			],
		});
		projection.apply({ sessionUpdate: "tool_call_update", toolCallId: "patch-1", status: "completed" });
		expect(projection.cells).toHaveLength(2);
		expect(projection.cells[0]).toMatchObject({
			toolCallId: "patch-1",
			toolName: "edit",
			args: { path: "C:\\p\\a.txt" },
			details: { diff: "-1 one\n+1 ONE" },
			status: "done",
		});
		expect(projection.cells[1]).toMatchObject({
			toolCallId: "patch-1#1",
			toolName: "write",
			args: { path: "C:\\p\\new.txt", content: "hello\n" },
			status: "done",
		});
	});

	test("a running command shows what it has printed so far", () => {
		const projection = new AcpProjection(clock);
		projection.apply({ sessionUpdate: "tool_call", toolCallId: "c", kind: "execute", status: "in_progress", rawInput: { command: "make" } });
		const delta = (data: string) => ({ sessionUpdate: "tool_call_update", toolCallId: "c", _meta: { terminal_output_delta: { data } } });
		projection.apply(delta("building\n"));
		projection.apply(delta("linking\n"));
		expect(projection.cells[0]).toMatchObject({ toolName: "bash", output: "building\nlinking\n", status: "running" });
		projection.apply({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed", rawOutput: { formatted_output: "done\n" } });
		expect(projection.cells[0]).toMatchObject({ output: "done\n", status: "done" });
	});

	test("files a command changed go in right under it", () => {
		const projection = new AcpProjection(clock);
		projection.apply({ sessionUpdate: "tool_call", toolCallId: "c", kind: "execute", status: "completed", rawInput: { command: "fmt" } });
		projection.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Formatted." } });
		expect(projection.addShellChanges("c", [])).toBe(false);
		expect(
			projection.addShellChanges("c", [
				{ path: "/p/a.ts", kind: "update", diff: "-1 a\n+1 A" },
				{ path: "/p/b.ts", kind: "add", diff: "+1 b", content: "b" },
			]),
		).toBe(true);
		expect(projection.cells.map((cell) => (cell.type === "tool" ? cell.toolName : cell.type))).toEqual(["bash", "edit", "write", "assistant"]);
		expect(projection.cells[1]).toMatchObject({ args: { path: "/p/a.ts" }, details: { diff: "-1 a\n+1 A" }, status: "done" });
		expect(projection.cells[2]).toMatchObject({ args: { path: "/p/b.ts", content: "b" } });
		// A late update to the command leaves its file cards be.
		projection.apply({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed" });
		expect(projection.cells).toHaveLength(4);
	});

	test("maps diffs onto the edit and write cards", () => {
		expect(
			mapToolCall({ toolCallId: "1", kind: "edit", content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }] }),
		).toMatchObject({ toolName: "edit", args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] } });
		expect(
			mapToolCall({ toolCallId: "2", kind: "edit", content: [{ type: "diff", path: "new.ts", oldText: null, newText: "x" }] }),
		).toMatchObject({ toolName: "write", args: { path: "new.ts", content: "x" } });
		expect(
			mapToolCall({ toolCallId: "3", kind: "read", locations: [{ path: "src/a.ts" }], status: "completed" }),
		).toMatchObject({ toolName: "read", args: { path: "src/a.ts" }, status: "done" });
	});

	test("tracks context, title, commands, and config options", () => {
		const projection = new AcpProjection(clock);
		projection.applySessionSetup({
			sessionId: "s",
			configOptions: [
				{ id: "mode", name: "Mode", type: "select", currentValue: "agent", options: [{ value: "agent", name: "Agent" }, { value: "read-only", name: "Read only" }] },
				{ id: "fast", name: "Fast", type: "boolean", currentValue: false },
			],
		});
		projection.apply({ sessionUpdate: "usage_update", used: 17156, size: 828400 });
		projection.apply({ sessionUpdate: "session_info_update", title: "Probe" });
		projection.apply({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review", input: { hint: "instructions" } }] });
		projection.apply({ sessionUpdate: "config_option_update", configOptions: [{ id: "mode", name: "Mode", type: "select", currentValue: "read-only", options: [{ value: "agent", name: "Agent" }, { value: "read-only", name: "Read only" }] }] });
		expect(projection.context).toEqual({ used: 17156, window: 828400 });
		expect(projection.title).toBe("Probe");
		expect(projection.commands).toEqual([{ name: "review", description: "Review", hint: "instructions" }]);
		expect(projection.configOptions()).toEqual([
			{ id: "mode", name: "Mode", currentValue: "read-only", options: [{ value: "agent", name: "Agent" }, { value: "read-only", name: "Read only" }] },
		]);
	});

	test("synthesizes a mode picker for agents without config options", () => {
		const projection = new AcpProjection(clock);
		projection.applySessionSetup({ sessionId: "s", modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] } });
		projection.apply({ sessionUpdate: "current_mode_update", currentModeId: "code" });
		expect(projection.configOptions()).toEqual([
			{ id: MODE_CONFIG_ID, name: "Mode", currentValue: "code", options: [{ value: "ask", name: "Ask" }, { value: "code", name: "Code" }] },
		]);
	});

	test("finishing a turn settles open tools and attaches usage", () => {
		const projection = new AcpProjection(clock);
		projection.addUserPrompt("go");
		projection.apply({ sessionUpdate: "tool_call", toolCallId: "t", kind: "execute", status: "in_progress", rawInput: { command: "sleep 9" } });
		projection.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
		const usage = turnUsageFromAcp({ totalTokens: 17196, inputTokens: 1051, cachedReadTokens: 16128, outputTokens: 17, thoughtTokens: 10 }, 500);
		projection.finishTurn("cancelled", usage, "Codex");
		expect(projection.cells[1]).toMatchObject({ type: "tool", status: "error" });
		expect(projection.cells[2]).toMatchObject({
			type: "assistant",
			streaming: false,
			usage: { provider: "Codex", input: 1051, cacheRead: 16128, output: 17, reasoning: 10, totalTokens: 17196 },
		});
		expect(projection.cells[3]).toMatchObject({ type: "notice", text: "已停止" });
	});
});

const AGENT: AcpAgentDefinition = {
	id: "fake",
	name: "Fake",
	description: "",
	command: "fake",
	args: [],
	env: {},
	enabled: true,
	builtin: false,
};

/** A scripted agent: answers the handshake and lets each test drive the turn. */
function startSession(options: { authRequired?: boolean; onUsage?: (usage: TurnUsage, timestamp: number) => void } = {}) {
	const transport = new FakeTransport();
	let changes = 0;
	const prompts: Message[] = [];
	transport.responder = (message) => {
		const { id, method } = message;
		if (method === "initialize") {
			transport.reply(id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [{ id: "api-key", name: "API Key" }] });
		} else if (method === "session/new") {
			if (options.authRequired) {
				transport.deliver({ jsonrpc: "2.0", id, error: { code: AUTH_REQUIRED, message: "Authentication required" } });
			} else {
				transport.reply(id, { sessionId: "agent-1", modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }] } });
			}
		} else if (method === "session/prompt") {
			prompts.push(message);
		} else if (method === "session/set_mode") {
			transport.reply(id, {});
		}
	};
	const session = new AcpSession({
		id: "local-1",
		agent: AGENT,
		cwd: "/project",
		clientVersion: "0.0.0",
		createTransport: () => transport,
		onChange: () => changes++,
		onUsage: options.onUsage,
		now: () => 1000,
	});
	return { session, transport, prompts, changes: () => changes };
}

describe("AcpSession", () => {
	test("a prompt waits for an in-flight config change before reaching the agent", async () => {
		const { session, transport, prompts } = startSession();
		await session.start();
		const responder = transport.responder!;
		let config: Message | undefined;
		transport.responder = (message) => {
			if (message.method === "session/set_mode") config = message;
			else responder(message);
		};
		const setting = session.setConfig(MODE_CONFIG_ID, "agent");
		const turn = session.prompt("use the selected mode");
		try {
			await tick();
			expect(config).toBeDefined();
			expect(prompts).toHaveLength(0);
			transport.reply(config!.id, {});
			await setting;
			await tick();
			expect(prompts).toHaveLength(1);
			transport.reply(prompts[0].id, { stopReason: "end_turn" });
			await turn;
		} finally {
			session.dispose();
			await Promise.allSettled([setting, turn]);
		}
	});

	test("only one first prompt can wait for session startup", async () => {
		const { session, transport, prompts } = startSession();
		const starting = session.start();
		const first = session.prompt("first");
		let secondError: unknown;
		const second = session.prompt("second").catch((error) => { secondError = error; });
		try {
			await starting;
			await tick();
			expect(secondError).toBeInstanceOf(Error);
			expect(prompts).toHaveLength(1);
			transport.reply(prompts[0].id, { stopReason: "end_turn" });
			await first;
			expect(session.snapshot().cells.filter((cell) => cell.type === "user")).toHaveLength(1);
		} finally {
			session.dispose();
			await Promise.allSettled([first, second]);
		}
	});

	test("a queued prompt can be cancelled while its config change is pending", async () => {
		const { session, transport, prompts } = startSession();
		await session.start();
		const responder = transport.responder!;
		let config: Message | undefined;
		transport.responder = (message) => {
			if (message.method === "session/set_mode") config = message;
			else responder(message);
		};
		const setting = session.setConfig(MODE_CONFIG_ID, "agent");
		const turn = session.prompt("cancel before dispatch");
		try {
			await tick();
			await session.cancel();
			transport.reply(config!.id, {});
			await Promise.all([setting, turn]);
			expect(prompts).toHaveLength(0);
			expect(session.snapshot().status).toBe("ready");
		} finally { session.dispose(); }
	});

	test("a failed pending configuration does not send a prompt with the old settings", async () => {
		const { session, transport, prompts } = startSession();
		await session.start();
		const responder = transport.responder!;
		let config: Message | undefined;
		transport.responder = (message) => {
			if (message.method === "session/set_mode") config = message;
			else responder(message);
		};
		const setting = session.setConfig(MODE_CONFIG_ID, "agent").catch(() => undefined);
		const turn = session.prompt("use the chosen settings");
		try {
			await tick();
			transport.deliver({ jsonrpc: "2.0", id: config!.id, error: { code: -32602, message: "mode unavailable" } });
			await Promise.all([setting, turn]);
			expect(prompts).toHaveLength(0);
			expect(session.snapshot().status).toBe("ready");
			expect(JSON.stringify(session.snapshot().cells)).toContain("mode unavailable");
		} finally { session.dispose(); }
	});

	test("reports prompt usage once even without an assistant text cell, including cancelled turns", async () => {
		const recorded: TurnUsage[] = [];
		const { session, transport, prompts } = startSession({ onUsage: (usage) => recorded.push(usage) });
		await session.start();
		try {
			const first = session.prompt("first");
			await tick();
			transport.update("agent-1", { sessionUpdate: "usage_update", used: 100, size: 1000 });
			transport.reply(prompts[0].id, { stopReason: "cancelled", usage: {
				inputTokens: 10, outputTokens: 5, cachedReadTokens: 20, totalTokens: 35,
			} });
			await first;
			expect(recorded).toHaveLength(1);
			expect(recorded[0]).toMatchObject({ provider: AGENT.name, calls: 1, input: 10, output: 5, cacheRead: 20 });
			const second = session.prompt("no usage");
			await tick();
			transport.reply(prompts[1].id, { stopReason: "end_turn" });
			await second;
			expect(recorded).toHaveLength(1);
		} finally {
			session.dispose();
		}
	});

	test("handshakes, runs a turn, and ends it on the prompt response", async () => {
		const { session, transport, prompts } = startSession();
		await session.start();
		expect(session.snapshot()).toMatchObject({ status: "ready", supportsImages: true });
		expect(transport.sent[0]).toMatchObject({
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
		});
		expect(transport.sent[1]).toMatchObject({ method: "session/new", params: { cwd: "/project", mcpServers: [] } });

		// Ready and offering its pickers, but not a conversation until a message goes out.
		expect(session.snapshot().pristine).toBe(true);
		const turn = session.prompt("hello");
		await tick();
		expect(session.snapshot()).toMatchObject({ status: "prompting", pristine: false });
		expect(prompts[0]).toMatchObject({ params: { sessionId: "agent-1", prompt: [{ type: "text", text: "hello" }] } });
		transport.update("agent-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi!" } });
		// Updates for another session on the same connection are not ours.
		transport.update("other", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "nope" } });
		transport.reply(prompts[0].id, { stopReason: "end_turn" });
		await turn;
		const snapshot = session.snapshot();
		expect(snapshot.status).toBe("ready");
		expect(snapshot.title).toBe("hello");
		expect(snapshot.cells.map((cell) => cell.type)).toEqual(["user", "assistant"]);
		expect(snapshot.cells[1]).toMatchObject({ text: "Hi!", streaming: false });
	});

	test("holds a permission request until the user answers it", async () => {
		const { session, transport, prompts } = startSession();
		await session.start();
		const turn = session.prompt("delete it");
		await tick();
		transport.deliver({
			jsonrpc: "2.0",
			id: 99,
			method: "session/request_permission",
			params: {
				sessionId: "agent-1",
				toolCall: { toolCallId: "t1", title: "rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
				options: [
					{ optionId: "yes", name: "Allow", kind: "allow_once" },
					{ optionId: "no", name: "Reject", kind: "reject_once" },
				],
			},
		});
		await tick();
		const [request] = session.snapshot().permissions;
		expect(request).toMatchObject({ toolCallId: "t1", title: "rm -rf build" });
		// A title that already is the command is not repeated as its detail.
		expect(request.detail).toBeUndefined();
		expect(session.snapshot().cells.at(-1)).toMatchObject({ type: "tool", toolName: "bash" });
		expect(transport.sent.some((message) => message.id === 99)).toBe(false);

		session.respondPermission(request.id, "yes");
		await tick();
		expect(transport.sent.find((message) => message.id === 99)).toEqual({
			jsonrpc: "2.0",
			id: 99,
			result: { outcome: { outcome: "selected", optionId: "yes" } },
		});
		expect(session.snapshot().permissions).toEqual([]);
		transport.reply(prompts[0].id, { stopReason: "end_turn" });
		await turn;
	});

	test("a generic permission title carries the command as its detail", async () => {
		const { session, transport } = startSession();
		await session.start();
		void session.prompt("go");
		await tick();
		transport.deliver({
			jsonrpc: "2.0",
			id: 42,
			method: "session/request_permission",
			params: {
				sessionId: "agent-1",
				toolCall: { toolCallId: "t9", title: "Run command", kind: "execute", rawInput: { command: "Set-Content x.txt neko" } },
				options: [{ optionId: "yes", name: "Yes, proceed", kind: "allow_once" }],
			},
		});
		await tick();
		expect(session.snapshot().permissions[0]).toMatchObject({ title: "Run command", detail: "Set-Content x.txt neko" });
	});

	test("cancel answers open permission prompts as cancelled and notifies the agent", async () => {
		const { session, transport, prompts } = startSession();
		await session.start();
		const turn = session.prompt("go");
		await tick();
		transport.deliver({
			jsonrpc: "2.0",
			id: 5,
			method: "session/request_permission",
			params: { sessionId: "agent-1", toolCall: { toolCallId: "t" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] },
		});
		await tick();
		await session.cancel();
		await tick();
		expect(transport.sent.find((message) => message.id === 5)).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
		expect(transport.sent.find((message) => message.method === "session/cancel")).toMatchObject({ params: { sessionId: "agent-1" } });
		transport.reply(prompts[0].id, { stopReason: "cancelled" });
		await turn;
		expect(session.snapshot().cells.at(-1)).toMatchObject({ type: "notice", text: "已停止" });
	});

	test("explains a login requirement instead of the raw RPC error", async () => {
		const { session, transport } = startSession({ authRequired: true });
		await session.start();
		const snapshot = session.snapshot();
		expect(snapshot.status).toBe("error");
		expect(snapshot.error).toContain("需要登录");
		expect(snapshot.error).toContain("API Key");
		expect(transport.closed).toBe(true);
	});

	test("a process that dies mid-turn fails the turn and the session", async () => {
		const { session, transport } = startSession();
		await session.start();
		const turn = session.prompt("go");
		await tick();
		transport.die("codex-acp crashed");
		await turn;
		const snapshot = session.snapshot();
		expect(snapshot).toMatchObject({ status: "error", error: "codex-acp crashed", streaming: false });
		expect(snapshot.cells.at(-1)).toMatchObject({ type: "notice", level: "error" });
		await expect(session.prompt("again")).rejects.toThrow("codex-acp crashed");
	});

	test("switches a synthesized mode through session/set_mode", async () => {
		const { session, transport } = startSession();
		await session.start();
		await session.setConfig(MODE_CONFIG_ID, "agent");
		expect(transport.sent.at(-1)).toMatchObject({ method: "session/set_mode", params: { sessionId: "agent-1", modeId: "agent" } });
	});
});

/** A config store holding exactly the given agents. */
function memoryStore(agents: AcpAgentDefinition[]) {
	return {
		list: () => agents,
		find: (id: string) => agents.find((agent) => agent.id === id),
		save: () => {
			throw new Error("read-only");
		},
		remove: () => undefined,
	};
}

/**
 * A scripted agent process for the service: it keeps two pages of history and
 * replays one conversation on `session/load`.
 */
function historyAgent(transports: FakeTransport[]) {
	return () => {
		const transport = new FakeTransport();
		transports.push(transport);
		transport.responder = (message) => {
			const { id, method, params } = message as { id: unknown; method: string; params: Message };
			if (method === "initialize") {
				transport.reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } });
			} else if (method === "session/list") {
				transport.reply(
					id,
					params?.cursor
						? { sessions: [{ sessionId: "old", cwd: tmpdir(), title: "Older", updatedAt: "2026-09-01T00:00:00.000Z" }] }
						: {
								sessions: [{ sessionId: "new", cwd: tmpdir(), title: "Newer", updatedAt: "2026-09-20T00:00:00.000Z" }],
								nextCursor: "page-2",
							},
				);
			} else if (method === "session/load") {
				transport.update(String(params.sessionId), {
					sessionUpdate: "user_message_chunk",
					messageId: "u1",
					content: { type: "text", text: "earlier question" },
				});
				transport.update(String(params.sessionId), {
					sessionUpdate: "agent_message_chunk",
					messageId: "a1",
					content: { type: "text", text: "earlier answer" },
				});
				transport.reply(id, { modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }] } });
			} else if (method === "session/new") {
				transport.reply(id, { sessionId: "fresh" });
			}
		};
		return transport;
	};
}

async function until(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !predicate(); i++) await tick();
	expect(predicate()).toBe(true);
}

describe("AcpService", () => {
	test("long ACP histories are windowed for reads and pushes, and can be paged without losing messages", async () => {
		const transport = new FakeTransport();
		transport.responder = ({ id, method }) => {
			if (method === "initialize") transport.reply(id, { protocolVersion: 1, agentCapabilities: {} });
			if (method === "session/new") transport.reply(id, { sessionId: "agent-long" });
		};
		const pushed: AcpSessionSnapshot[] = [];
		const service = new AcpService({ store: memoryStore([AGENT]) as never, clientVersion: "0", emitState: () => {},
			emitSnapshot: (snapshot) => pushed.push(snapshot), createTransport: () => transport, shellChanges: async () => null });
		try {
			const created = service.create({ agentId: AGENT.id, cwd: tmpdir() });
			await until(() => service.snapshot(created.id)?.status === "ready");
			const append = (index: number) => {
				transport.update("agent-long", { sessionUpdate: "user_message_chunk", messageId: `u-${index}`, content: { type: "text", text: `question-${index}` } });
				transport.update("agent-long", { sessionUpdate: "agent_message_chunk", messageId: `a-${index}`, content: { type: "text", text: `answer-${index}` } });
			};
			for (let index = 0; index < 300; index++) append(index);
			await until(() => pushed.at(-1)?.cells.at(-1)?.type === "assistant");
			expect(service.snapshot(created.id)?.cells).toHaveLength(600);
			expect(pushed.at(-1)?.cells).toHaveLength(80);
			expect(service.view(created.id)?.cells).toHaveLength(600);
			expect(service.desktopView(created.id)).toMatchObject({ earlierCells: 520 });
			const earlier = service.desktopView(created.id, true)!;
			expect(earlier.cells).toHaveLength(160);
			expect(earlier.earlierCells).toBe(440);
			append(300);
			await until(() => pushed.at(-1)?.cells.length === 162);
			expect(pushed.at(-1)?.cells[0].id).toBe(earlier.cells[0].id);
			expect(service.desktopView(created.id)?.cells).toHaveLength(80);
			append(301);
			await until(() => pushed.at(-1)?.cells.length === 80 && (pushed.at(-1)?.cells.at(-1) as { text?: string })?.text === "answer-301");
			let all = service.desktopView(created.id, true)!;
			while (all.earlierCells) all = service.desktopView(created.id, true)!;
			expect(all.cells).toEqual(service.snapshot(created.id)!.cells);
			expect(all.cells).toHaveLength(604);
			service.close(created.id);
			expect(service.desktopView(created.id, true)).toBeNull();
		} finally { service.dispose(); }
	});

	test("persists new prompt usage before notifying the dashboard and never counts history replay", async () => {
		const root = mkdtempSync(join(tmpdir(), "acp-service-usage-"));
		const transports: FakeTransport[] = [];
		const acpUsageDir = join(root, "usage");
		const stats = new TokenStatsService({ sessionDir: join(root, "sessions"), acpUsageDir });
		let refreshed: ReturnType<TokenStatsService["report"]> | undefined;
		const service = new AcpService({
			clientVersion: "0.0.0", store: memoryStore([AGENT]), usageDir: acpUsageDir,
			createTransport: historyAgent(transports), emitState: () => {}, emitSnapshot: () => {},
			emitHistoryChanged: () => { refreshed = stats.report(); }, shellChanges: async () => null,
		});
		try {
			const opened = service.openHistory({ agentId: AGENT.id, sessionId: "new", cwd: tmpdir(), title: "Existing" });
			await until(() => service.snapshot(opened.id)?.status === "ready");
			expect((await stats.report()).sessions).toHaveLength(0);
			await service.prompt({ sessionId: opened.id, text: "next" });
			await until(() => transports[0].sent.some((message) => message.method === "session/prompt"));
			const request = transports[0].sent.find((message) => message.method === "session/prompt")!;
			transports[0].reply(request.id, { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } });
			await until(() => refreshed !== undefined);
			expect((await refreshed!).sessions[0]).toMatchObject({ calls: 1, input: 100, output: 10 });
			service.close(opened.id);
			const reopened = service.openHistory({ agentId: AGENT.id, sessionId: "new", cwd: tmpdir(), title: "Existing" });
			await until(() => service.snapshot(reopened.id)?.status === "ready");
			expect((await stats.report()).sessions).toHaveLength(1);
			expect((await stats.report()).sessions[0].calls).toBe(1);
		} finally {
			service.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("two windows in the same directory keep streamed replies and edits in their own sessions", async () => {
		const transports: FakeTransport[] = [];
		const pushed: Array<{ id: string; cells: AgentCell[] }> = [];
		const service = new AcpService({
			clientVersion: "0", store: memoryStore([AGENT]), emitState: () => {},
			emitSnapshot: (next) => pushed.push(next), shellChanges: async () => null,
			createTransport: () => {
				const transport = new FakeTransport();
				const agentId = `agent-${transports.length}`;
				transports.push(transport);
				transport.responder = (message) => {
					if (message.method === "initialize") transport.reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
					if (message.method === "session/new") transport.reply(message.id, { sessionId: agentId });
				};
				return transport;
			},
		});
		try {
			const a = service.create({ agentId: "fake", cwd: tmpdir(), warm: true }, "window-a");
			const b = service.create({ agentId: "fake", cwd: tmpdir(), warm: true }, "window-b");
			expect(a.id).not.toBe(b.id);
			await until(() => service.state().sessions.every((session) => session.status === "ready"));
			await service.prompt({ sessionId: a.id, text: "question A" });
			await service.prompt({ sessionId: b.id, text: "question B" });
			await until(() => transports.every((transport) => transport.sent.some((message) => message.method === "session/prompt")));
			for (let i = 0; i < 1000; i++) {
				transports[0].update("agent-0", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A" } });
				transports[1].update("agent-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B" } });
			}
			for (let i = 0; i < 2; i++) {
				transports[i].update(`agent-${i}`, {
					sessionUpdate: "tool_call", toolCallId: "same-tool-id", kind: "edit", status: "completed",
					content: [{ type: "diff", path: `/project/${i}.txt`, oldText: "old", newText: `window-${i}` }],
				});
				const prompt = transports[i].sent.find((message) => message.method === "session/prompt")!;
				expect(prompt.params).toMatchObject({ sessionId: `agent-${i}` });
				transports[i].reply(prompt.id, { stopReason: "end_turn" });
			}
			await until(() => service.state().sessions.every((session) => session.status === "ready"));
			await until(() => [a.id, b.id].every((id) => pushed.some((next) => next.id === id && next.cells.some((cell) => cell.type === "tool"))));
			for (const [index, id] of [a.id, b.id].entries()) {
				const cells = service.snapshot(id)!.cells;
				expect(cells.find((cell) => cell.type === "assistant")).toMatchObject({ text: (index === 0 ? "A" : "B").repeat(1000) });
				expect(cells.find((cell) => cell.type === "tool")).toMatchObject({ args: { path: `/project/${index}.txt` } });
				expect(pushed.filter((next) => next.id === id).every((next) => next.cells
					.filter((cell) => cell.type === "assistant").every((cell) => cell.text === (index === 0 ? "A" : "B").repeat(cell.text.length)))).toBe(true);
			}
		} finally {
			service.dispose();
		}
	});

	test("refuses a project directory that does not exist", () => {
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([AGENT]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: () => new FakeTransport(),
		});
		expect(() => service.create({ agentId: "fake", cwd: "Z:/definitely/not/here" })).toThrow("项目目录不存在");
		expect(service.state().sessions).toEqual([]);
	});

	test("refuses an agent switched off in settings", () => {
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([{ ...AGENT, enabled: false }]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: () => new FakeTransport(),
		});
		expect(() => service.create({ agentId: "fake", cwd: tmpdir() })).toThrow("已在设置中停用");
	});

	test("lists the agent's own history across pages, newest first", async () => {
		const transports: FakeTransport[] = [];
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([AGENT]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: historyAgent(transports),
		});
		const history = await service.history("fake");
		expect(history.error).toBeUndefined();
		expect(history.entries.map((entry) => entry.title)).toEqual(["Newer", "Older"]);
		expect(transports[0].sent.filter((message) => message.method === "session/list").map((message) => message.params)).toEqual([
			{},
			{ cursor: "page-2" },
		]);
		// The listing process is kept for the next listing rather than respawned.
		await service.history("fake");
		expect(transports).toHaveLength(1);
		service.dispose();
		expect(transports[0].closed).toBe(true);
	});

	test("reports a history failure instead of throwing", async () => {
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([AGENT]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: () => {
				const transport = new FakeTransport();
				transport.responder = () => transport.die("codex not installed");
				return transport;
			},
		});
		expect(await service.history("fake")).toEqual({ agentId: "fake", entries: [], error: "codex not installed" });
	});

	test("reopens a conversation from history with its transcript replayed", async () => {
		const transports: FakeTransport[] = [];
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([AGENT]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: historyAgent(transports),
		});
		const opened = service.openHistory({ agentId: "fake", sessionId: "new", cwd: tmpdir(), title: "Newer" });
		await until(() => service.snapshot(opened.id)?.status === "ready");
		const snapshot = service.snapshot(opened.id)!;
		expect(snapshot).toMatchObject({ agentSessionId: "new", title: "Newer", pristine: false });
		expect(snapshot.cells.map((cell) => [cell.type, (cell as { text?: string }).text])).toEqual([
			["user", "earlier question"],
			["assistant", "earlier answer"],
		]);
		expect(snapshot.cells[1]).toMatchObject({ streaming: false });
		expect(transports[0].sent.find((message) => message.method === "session/load")).toMatchObject({
			params: { sessionId: "new", cwd: tmpdir() },
		});
		// The same conversation is not opened twice.
		expect(service.openHistory({ agentId: "fake", sessionId: "new", cwd: tmpdir() }).id).toBe(opened.id);
		service.dispose();
	});

	test("keeps only the most recently used idle sessions open", async () => {
		const transports: FakeTransport[] = [];
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([AGENT]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: historyAgent(transports),
		});
		const ids: string[] = [];
		const open = async () => {
			const id = service.create({ agentId: "fake", cwd: tmpdir() }).id;
			ids.push(id);
			await until(() => service.snapshot(id)?.status === "ready");
			await new Promise((resolve) => setTimeout(resolve, 2));
		};
		for (let i = 0; i < 4; i++) await open();
		// Looking at the first one again keeps it from being the one that goes.
		service.view(ids[0]);
		await new Promise((resolve) => setTimeout(resolve, 2));
		await open();
		await open();
		const remaining = service.state().sessions.map((session) => session.id);
		expect(remaining).toContain(ids[0]);
		expect(remaining).not.toContain(ids[1]);
		expect(remaining).toHaveLength(5);
		service.dispose();
	});

	test("a conversation whose project was deleted still opens for reading", async () => {
		const transports: FakeTransport[] = [];
		const cwds: string[] = [];
		const factory = historyAgent(transports);
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([AGENT]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: (agent, cwd) => {
				cwds.push(cwd);
				return factory();
			},
		});
		const gone = join(tmpdir(), "acp-deleted-project-that-does-not-exist");
		const opened = service.openHistory({ agentId: "fake", sessionId: "old", cwd: gone });
		await until(() => service.snapshot(opened.id)?.status === "ready");
		expect(cwds).toEqual([homedir()]);
		expect(transports[0].sent.find((message) => message.method === "session/load")).toMatchObject({ params: { cwd: gone } });
		expect(service.snapshot(opened.id)?.cells.at(-1)).toMatchObject({ type: "notice", level: "warning" });
		service.dispose();
	});

	test("switching providers reconnects unsent composers and preserves existing conversations", async () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-provider-warm-"));
		const store = new AcpConfigStore(dir);
		const transports: FakeTransport[] = [];
		const official = { id: "official", name: "Official", category: "official", websiteUrl: "", notes: "", config: "", apiKey: "", env: {} };
		const custom = { ...official, id: "custom", name: "Custom", category: "custom", config: 'model_provider = "custom"\nmodel = "example"\n[model_providers.custom]\nbase_url = "https://example.test/v1"\nwire_api = "responses"', apiKey: "test-key" };
		const providerState = { activeId: official.id, profiles: [official, custom] };
		store.save({ ...store.find("codex")!, providerState });
		const service = new AcpService({ clientVersion: "0", store, emitState: () => {}, emitSnapshot: () => {}, createTransport: historyAgent(transports) });
		try {
			const warm = service.create({ agentId: "codex", cwd: tmpdir(), warm: true }, "a");
			const conversation = service.create({ agentId: "codex", cwd: tmpdir(), warm: true }, "b");
			await service.prompt({ sessionId: conversation.id, text: "hello" });
			service.saveAgent({ ...store.find("codex")!, providerState: { ...providerState, profiles: [official, { ...custom, notes: "updated inactive provider" }] } });
			expect(service.snapshot(warm.id)).not.toBeNull();
			service.saveAgent({ ...store.find("codex")!, providerState: { ...providerState, activeId: custom.id } });
			expect(service.snapshot(warm.id)).toBeNull();
			expect(service.snapshot(conversation.id)).not.toBeNull();
			const next = service.create({ agentId: "codex", cwd: tmpdir(), warm: true }, "a");
			expect(next.id).not.toBe(warm.id);
		} finally { service.dispose(); rmSync(dir, { recursive: true, force: true }); }
	});

	test("warming is deduplicated only within the requesting window", async () => {
		const transports: FakeTransport[] = [];
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([AGENT]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: historyAgent(transports),
		});
		const first = service.create({ agentId: "fake", cwd: tmpdir(), warm: true }, "window-a");
		const second = service.create({ agentId: "fake", cwd: tmpdir(), warm: true }, "window-a");
		expect(second.id).toBe(first.id);
		const otherWindow = service.create({ agentId: "fake", cwd: tmpdir(), warm: true }, "window-b");
		expect(otherWindow.id).not.toBe(first.id);
		expect(service.create({ agentId: "fake", cwd: tmpdir(), warm: true }, "window-b").id).toBe(otherWindow.id);
		// A session that has had a message is a conversation, never handed out as warm.
		await service.prompt({ sessionId: first.id, text: "hi" });
		expect(service.create({ agentId: "fake", cwd: tmpdir(), warm: true }, "window-a").id).not.toBe(first.id);
		// Without `warm`, create always starts a new one.
		expect(service.create({ agentId: "fake", cwd: tmpdir() }).id).not.toBe(first.id);
		// Anonymous clients (e.g. LAN callers) must never borrow a window's session.
		const anonymous = service.create({ agentId: "fake", cwd: tmpdir(), warm: true });
		expect(anonymous.id).not.toBe(otherWindow.id);
		expect(service.create({ agentId: "fake", cwd: tmpdir(), warm: true }).id).not.toBe(anonymous.id);
		service.dispose();
	});

	test("a first prompt sent while the agent starts goes out once it is ready", async () => {
		const transports: FakeTransport[] = [];
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([AGENT]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: historyAgent(transports),
		});
		const created = service.create({ agentId: "fake", cwd: tmpdir() });
		await service.prompt({ sessionId: created.id, text: "hello" });
		expect(service.snapshot(created.id)?.cells[0]).toMatchObject({ type: "user", text: "hello" });
		await until(() => transports[0]?.sent.some((message) => message.method === "session/prompt") ?? false);
		expect(transports[0].sent.find((message) => message.method === "session/prompt")).toMatchObject({
			params: { sessionId: "fresh", prompt: [{ type: "text", text: "hello" }] },
		});
		service.dispose();
	});
});

describe("NekoCode tools in ACP sessions", () => {
	const servers = [{ type: "http" as const, name: "nekocode", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] }];

	function toolSession(mcpCapabilities: Record<string, unknown>) {
		const transport = new FakeTransport();
		let disposed = 0;
		transport.responder = (message) => {
			const { id, method } = message;
			if (method === "initialize") transport.reply(id, { protocolVersion: 1, agentCapabilities: { mcpCapabilities } });
			else if (method === "session/new") transport.reply(id, { sessionId: "s" });
		};
		const session = new AcpSession({
			id: "local",
			agent: AGENT,
			cwd: "/p",
			clientVersion: "0",
			createTransport: () => transport,
			onChange: () => {},
			toolServers: async () => ({ servers, dispose: () => disposed++ }),
		});
		return { session, transport, disposed: () => disposed };
	}

	test("an agent that takes HTTP MCP servers gets NekoCode's tools on session/new", async () => {
		const { session, transport, disposed } = toolSession({ http: true });
		await session.start();
		expect(transport.sent.find((message) => message.method === "session/new")).toMatchObject({ params: { mcpServers: servers } });
		session.dispose();
		expect(disposed()).toBe(1);
	});

	test("an adapter's session meta goes out with session/new", async () => {
		const transport = new FakeTransport();
		transport.responder = (message) => {
			if (message.method === "initialize") transport.reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
			else if (message.method === "session/new") transport.reply(message.id, { sessionId: "s" });
		};
		const meta = { systemPrompt: { append: "use Edit" } };
		const session = new AcpSession({
			id: "local",
			agent: { ...AGENT, bundled: { ...BUILTIN_ACP_AGENTS.find((agent) => agent.id === "claude")!.bundled!, sessionMeta: meta } },
			cwd: "/p",
			clientVersion: "0",
			createTransport: () => transport,
			onChange: () => {},
		});
		await session.start();
		expect(transport.sent.find((message) => message.method === "session/new")).toMatchObject({ params: { cwd: "/p", _meta: meta } });
		session.dispose();
	});

	test("an agent without HTTP MCP goes without, and says so", async () => {
		const { session, transport, disposed } = toolSession({ http: false });
		await session.start();
		expect(transport.sent.find((message) => message.method === "session/new")).toMatchObject({ params: { mcpServers: [] } });
		expect(disposed()).toBe(1);
		expect(session.snapshot().cells.at(-1)).toMatchObject({ type: "notice", text: expect.stringContaining("HTTP") });
	});

	test("the tools go away when the agent dies", async () => {
		const { session, transport, disposed } = toolSession({ http: true });
		await session.start();
		transport.die("crashed");
		expect(disposed()).toBe(1);
	});
});

describe("AcpConfigStore", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});
	const freshDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-store-"));
		dirs.push(dir);
		return dir;
	};

	test("ships Codex on and every other agent off", () => {
		const store = new AcpConfigStore(freshDir());
		expect(store.list().map((agent) => [agent.id, agent.enabled])).toEqual([
			["codex", true],
			["claude", false],
			["cursor", false],
			["grok", false],
			["droid", false],
			["devin", false],
		]);
	});

	test("a built-in agent on its own CLI may be saved without a command", () => {
		const store = new AcpConfigStore(freshDir());
		const saved = store.save({ id: "cursor", name: "Cursor", command: "", args: [], env: {}, enabled: true });
		expect(saved).toMatchObject({ id: "cursor", command: "", enabled: true });
		expect(saved.native?.args).toEqual(["acp"]);
	});

	test("keeps changes to built-in and custom agents across restarts", () => {
		const dir = freshDir();
		const first = new AcpConfigStore(dir);
		first.save({ id: "claude", name: "Claude Agent", command: "npx", args: ["-y", "x"], env: { A: "1" }, enabled: true });
		const custom = first.save({ name: "Gemini", command: "gemini", args: ["--experimental-acp"], env: {}, enabled: true });

		const second = new AcpConfigStore(dir);
		expect(second.find("claude")).toMatchObject({ enabled: true, env: { A: "1" }, builtin: true });
		expect(second.find(custom.id)).toMatchObject({ name: "Gemini", command: "gemini", builtin: false });

		// Removing a built-in resets it; removing a custom one deletes it.
		second.remove("claude");
		second.remove(custom.id);
		const third = new AcpConfigStore(dir);
		expect(third.find("claude")).toMatchObject({ enabled: false, env: {} });
		expect(third.find(custom.id)).toBeUndefined();
	});

	test("rejects an agent without a name or command", () => {
		const store = new AcpConfigStore(freshDir());
		expect(() => store.save({ name: " ", command: "x", args: [], env: {}, enabled: true })).toThrow("名称");
		expect(() => store.save({ name: "x", command: "", args: [], env: {}, enabled: true })).toThrow("命令");
	});
});

describe("parseHistoryPage", () => {
	test("drops malformed rows and tolerates a missing time", () => {
		expect(
			parseHistoryPage({
				sessions: [{ sessionId: "a", cwd: "/p", title: " T " }, { sessionId: 1 }, { cwd: "/p" }],
				nextCursor: "",
			}),
		).toEqual({ entries: [{ sessionId: "a", cwd: "/p", title: "T", updatedAt: 0 }] });
	});
});

describe("agentProxyEnv", () => {
	test("hands NekoCode's proxy to the agent and keeps local hosts direct", () => {
		expect(agentProxyEnv("http://127.0.0.1:7897", { PATH: "x" })).toEqual({
			HTTPS_PROXY: "http://127.0.0.1:7897",
			HTTP_PROXY: "http://127.0.0.1:7897",
			ALL_PROXY: "http://127.0.0.1:7897",
			NO_PROXY: "localhost,127.0.0.1,::1",
		});
	});

	test("leaves variables the user set alone, whatever their case", () => {
		expect(agentProxyEnv("http://127.0.0.1:7897", { https_proxy: "http://corp:8080", no_proxy: "intranet" })).toEqual({
			HTTP_PROXY: "http://127.0.0.1:7897",
			ALL_PROXY: "http://127.0.0.1:7897",
			no_proxy: "intranet,localhost,127.0.0.1,::1",
		});
		expect(agentProxyEnv("http://127.0.0.1:7897", { HTTPS_PROXY: "a", HTTP_PROXY: "b", ALL_PROXY: "c" })).toEqual({
			NO_PROXY: "localhost,127.0.0.1,::1",
		});
	});

	test("keeps loopback direct even when NekoCode connects directly", () => {
		// The agent may still apply the OS proxy by itself, and the tool server is on loopback.
		expect(agentProxyEnv(undefined, {})).toEqual({ NO_PROXY: "localhost,127.0.0.1,::1" });
	});
});

describe("signing in to an agent with its own CLI", () => {
	function authSession(auth: AcpAuthPlan, script: { authRequiredUntilSignedIn?: boolean; authFails?: boolean } = {}) {
		const transport = new FakeTransport();
		let signedIn = false;
		transport.responder = (message) => {
			const { id, method } = message;
			if (method === "initialize") {
				transport.reply(id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cached_token" }, { id: "browser_login" }] });
			} else if (method === "authenticate") {
				if (script.authFails) {
					transport.deliver({ jsonrpc: "2.0", id, error: { code: -32000, message: "not logged in" } });
				} else {
					signedIn = true;
					transport.reply(id, {});
				}
			} else if (method === "session/new") {
				if (script.authRequiredUntilSignedIn && !signedIn) {
					transport.deliver({ jsonrpc: "2.0", id, error: { code: AUTH_REQUIRED, message: "Authentication required" } });
				} else {
					transport.reply(id, { sessionId: "agent-1" });
				}
			}
		};
		const session = new AcpSession({
			id: "local-1",
			agent: {
				...AGENT,
				builtin: true,
				command: "",
				native: { binary: "grok", args: ["stdio"], cliName: "Fake CLI", installHint: "", auth },
			},
			cwd: "/project",
			clientVersion: "0.0.0",
			createTransport: () => transport,
			onChange: () => {},
			env: { XAI_API_KEY: "" },
			now: () => 1000,
		});
		return { session, transport };
	}

	const methods = (transport: FakeTransport) => transport.sent.map((message) => message.method);

	test("signs in up front when the agent wants it before any session", async () => {
		const seen: string[][] = [];
		const { session, transport } = authSession({
			when: "always",
			choose: async (advertised) => {
				seen.push([...advertised]);
				return { methodId: "cached_token", meta: { headless: true } };
			},
		});
		await session.start();
		expect(session.snapshot().status).toBe("ready");
		expect(seen).toEqual([["cached_token", "browser_login"]]);
		expect(methods(transport)).toEqual(["initialize", "authenticate", "session/new"]);
		expect(transport.sent[1].params).toEqual({ methodId: "cached_token", _meta: { headless: true } });
	});

	test("signs in on demand and opens the session again, once", async () => {
		const { session, transport } = authSession(
			{ when: "on-demand", choose: async () => ({ methodId: "cached_token" }) },
			{ authRequiredUntilSignedIn: true },
		);
		await session.start();
		expect(session.snapshot().status).toBe("ready");
		expect(methods(transport)).toEqual(["initialize", "session/new", "authenticate", "session/new"]);
	});

	test("an on-demand agent that needs no sign-in is never asked to", async () => {
		const { session, transport } = authSession({ when: "on-demand", choose: async () => ({ methodId: "cached_token" }) });
		await session.start();
		expect(methods(transport)).toEqual(["initialize", "session/new"]);
	});

	test("says what to run when there is no usable login", async () => {
		const { session, transport } = authSession({
			when: "always",
			choose: async () => {
				throw new Error("请先在终端运行 fake login");
			},
		});
		await session.start();
		expect(session.snapshot()).toMatchObject({ status: "error", error: "请先在终端运行 fake login" });
		expect(methods(transport)).toEqual(["initialize"]);
	});

	test("a refused sign-in names the agent and the method", async () => {
		const { session } = authSession({ when: "always", choose: async () => ({ methodId: "cached_token" }) }, { authFails: true });
		await session.start();
		expect(session.snapshot().status).toBe("error");
		expect(session.snapshot().error).toContain("Fake 登录失败（cached_token）");
	});
});

describe("shell changes in ACP sessions", () => {
	test("a finished command gets cards for the files it changed; edit tools are noted, not shown twice", async () => {
		const transport = new FakeTransport();
		transport.responder = (message) => {
			if (message.method === "initialize") transport.reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
			else if (message.method === "session/new") transport.reply(message.id, { sessionId: "s" });
		};
		const calls: string[] = [];
		const tracker = {
			begin: async () => void calls.push("begin"),
			end: async () => void calls.push("end"),
			noteEdit: (id: string, paths: string[], done: boolean) => void calls.push(`edit ${id} ${paths.join(",")} ${done}`),
			settle: async () => {
				calls.push("settle");
				return [{ path: "/p/out.txt", kind: "add" as const, diff: "+1 hi", content: "hi" }];
			},
			dispose: () => void calls.push("dispose"),
		};
		const session = new AcpSession({
			id: "local",
			agent: AGENT,
			cwd: "/p",
			clientVersion: "0",
			createTransport: () => transport,
			onChange: () => {},
			shellChanges: async () => tracker as never,
		});
		await session.start();
		const turn = session.prompt("go");
		await tick();
		transport.update("s", { sessionUpdate: "tool_call", toolCallId: "e", kind: "edit", status: "in_progress", content: [{ type: "diff", path: "/p/a.ts", oldText: "a", newText: "b" }] });
		transport.update("s", { sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed" });
		transport.update("s", { sessionUpdate: "tool_call", toolCallId: "c", kind: "execute", status: "in_progress", rawInput: { command: "echo hi > out.txt" } });
		transport.update("s", { sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed" });
		// An MCP tool Codex reports as execute is not a command.
		transport.update("s", { sessionUpdate: "tool_call", toolCallId: "m", kind: "execute", status: "completed", rawInput: { server: "nekocode", tool: "grep" } });
		await tick();
		await tick();
		const prompt = transport.sent.find((message) => message.method === "session/prompt")!;
		transport.reply(prompt.id, { stopReason: "end_turn" });
		await turn;
		expect(calls).toEqual(["begin", "edit e /p/a.ts false", "edit e /p/a.ts true", "settle", "end"]);
		const tools = session.snapshot().cells.filter((cell) => cell.type === "tool");
		expect(tools.map((cell) => [cell.toolName, cell.toolCallId])).toEqual([
			["edit", "e"],
			["bash", "c"],
			["write", "c:/p/out.txt"],
			["grep", "m"],
		]);
		session.dispose();
		expect(calls.at(-1)).toBe("dispose");
	});
});
