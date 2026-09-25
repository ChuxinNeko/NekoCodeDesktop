import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCell } from "../../shared/agent";
import { AcpConnection, AcpRpcError, AUTH_REQUIRED, METHOD_NOT_FOUND, type AcpTransport } from "./connection";
import { AcpProjection, mapToolCall, MODE_CONFIG_ID, turnUsageFromAcp } from "./projection";
import { AcpSession } from "./session";
import { AcpService, parseHistoryPage } from "./service";
import { AcpConfigStore } from "./config-store";
import { agentProxyEnv, type AcpAgentDefinition } from "./agents";

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
function startSession(options: { authRequired?: boolean } = {}) {
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
		now: () => 1000,
	});
	return { session, transport, prompts, changes: () => changes };
}

describe("AcpSession", () => {
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

	test("warming twice for the same agent and directory gives one session", async () => {
		const transports: FakeTransport[] = [];
		const service = new AcpService({
			clientVersion: "0",
			store: memoryStore([AGENT]),
			emitState: () => {},
			emitSnapshot: () => {},
			createTransport: historyAgent(transports),
		});
		const first = service.create({ agentId: "fake", cwd: tmpdir(), warm: true });
		const second = service.create({ agentId: "fake", cwd: tmpdir(), warm: true });
		expect(second.id).toBe(first.id);
		// A session that has had a message is a conversation, never handed out as warm.
		await service.prompt({ sessionId: first.id, text: "hi" });
		expect(service.create({ agentId: "fake", cwd: tmpdir(), warm: true }).id).not.toBe(first.id);
		// Without `warm`, create always starts a new one.
		expect(service.create({ agentId: "fake", cwd: tmpdir() }).id).not.toBe(first.id);
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

	test("ships Codex on and Claude off", () => {
		const store = new AcpConfigStore(freshDir());
		expect(store.list().map((agent) => [agent.id, agent.enabled])).toEqual([
			["codex", true],
			["claude", false],
		]);
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
