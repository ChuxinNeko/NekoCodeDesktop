import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, ModelRuntime, SessionManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { McpService } from "../../src/main/mcp/service";
import { createWorkflowSession } from "../../src/main/workflow-runtime";
import { resolveWorkspacePath } from "../../src/main/workflow-paths";

async function fixture(fusion: boolean) {
	const cwd = await mkdtemp(join(tmpdir(), "mcp-session-sync-"));
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
		modelsStorePath: join(cwd, "models-store.json"), allowModelNetwork: false });
	await modelRuntime.setRuntimeApiKey("anthropic", "test-only");
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const lead = getModel("anthropic", "claude-opus-4-5")!;
	let schemaField = "old";
	let permission: "auto" | "read-only" = "auto";
	let round = 0;
	let calls = 0;
	const helperIds: string[] = [];
	let server!: InMemoryTransport;
	let sync: (() => void) | undefined;
	const service = new McpService(cwd, () => cwd, () => sync?.(), { createTransport: async () => {
		const pair = createInMemoryTransportPair(); server = pair.server;
		server.onMessage((message) => {
			const req = message as { id?: unknown; method: string; params?: Record<string, unknown> };
			if (req.id === undefined) return;
			const reply = (result: unknown) => void server.send({ jsonrpc: "2.0", id: req.id, result } as never);
			if (req.method === "initialize") reply({ protocolVersion: req.params?.protocolVersion,
				capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" } });
			else if (req.method === "tools/list") reply({ tools: [{ name: "echo", description: "Echo", inputSchema: {
				type: "object", properties: { [schemaField]: { type: "string" } }, required: [schemaField], additionalProperties: false,
			} }] });
			else if (req.method === "tools/call") { calls++; reply({ content: [{ type: "text", text: JSON.stringify(req.params?.arguments) }] }); }
		});
		await server.start(); return pair.client;
	} });
	modelRuntime.streamSimple = (selected, context, options) => {
		const stream = createAssistantMessageEventStream();
		helperIds.push(options?.sessionId ?? "missing");
		const system = getCurrentSystemPrompt(context.messages);
		if (fusion && (system.includes("structured plan") || system.includes("Reconcile the work"))) {
			const planning = system.includes("structured plan");
			queueMicrotask(() => stream.push({ type: "done", reason: planning ? "toolUse" : "stop", message: {
				...fauxAssistantMessage("done"), api: selected.api, provider: selected.provider, model: selected.id,
				content: planning ? [{ type: "toolCall", id: "fusion-plan", name: "fusion_submit_plan", arguments: {
					complexity: 0.2, mainTask: "Use MCP", sidekickTasks: [] } }] : [{ type: "text", text: "done" }],
				stopReason: planning ? "toolUse" : "stop",
			} }));
			return stream;
		}
		const toolUse = ++round % 2 === 1;
		queueMicrotask(() => stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message: {
			...fauxAssistantMessage("done"), api: selected.api, provider: selected.provider, model: selected.id,
			content: toolUse ? [{ type: "toolCall", id: `mcp-${round}`, name: "mcp__fake__echo", arguments: { [schemaField]: "value" } }]
				: [{ type: "text", text: "done" }], stopReason: toolUse ? "toolUse" : "stop",
		} })); return stream;
	};
	const { session, workflow } = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd,
		modelRuntime, model: lead, sessionManager: SessionManager.inMemory(cwd), initialMode: "agent",
		initialFusion: fusion ? { leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${model.provider}/${model.id}`,
			leadThinkingLevel: "off", sidekickThinkingLevel: "off", adaptiveRouting: false } : null,
		getPermission: () => permission, getMcpTools: () => service.tools(), getMcpToolsRevision: () => service.toolRevision,
		getPluginTools: () => service.toolNames(), onChange: () => undefined, onModeChange: () => undefined });
	sync = () => workflow.syncMcpTools();
	return { cwd, modelRuntime, service, session, workflow, helperIds, calls: () => calls,
		connect: () => service.save({ name: "fake", transport: "stdio", enabled: true, command: "unused" }),
		readOnly: () => { permission = "read-only"; workflow.refresh(); },
		changeSchema: async () => {
			schemaField = "new";
			await server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" } as never);
			for (let i = 0; i < 100 && !(service.tools()[0]?.parameters as any)?.properties?.new; i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			expect((service.tools()[0].parameters as any).properties.new).toBeDefined();
		},
		close: async () => { await session.abort(); workflow.dispose(); session.dispose(); service.close(); await rm(cwd, { recursive: true, force: true }); },
	};
}

describe("live MCP tools in real PI sessions", () => {
	test("replacing SDK definitions preserves explicit loadouts and built-in tools", async () => {
		const f = await fixture(false);
		let limited: AgentSession | undefined;
		try {
			({ session: limited } = await createAgentSession({ cwd: f.cwd, agentDir: join(f.cwd, "limited-agent"),
				modelRuntime: f.modelRuntime, model: f.session.model!, sessionManager: SessionManager.inMemory(f.cwd),
				tools: ["read", "mcp__late"] }));
			const tool: ToolDefinition = { name: "mcp__late", label: "late", description: "Late tool",
				parameters: { type: "object", properties: {} } as never,
				execute: async () => ({ content: [{ type: "text", text: "late" }], details: {} }) };
			limited.setActiveToolsByName(["read"]);
			limited.setCustomTools([tool]);
			expect(limited.getToolDefinition("mcp__late")).toBe(tool);
			expect(limited.getActiveToolNames()).toEqual(["read"]);
			limited.setActiveToolsByName(["read", "mcp__late"]);
			expect(limited.getActiveToolNames()).toContain("mcp__late");
			limited.setCustomTools([]);
			expect(limited.getToolDefinition("mcp__late")).toBeUndefined();
			expect(limited.getActiveToolNames()).toEqual(["read"]);
		} finally { limited?.dispose(); await f.close(); }
	});

	for (const fusion of [false, true]) test(`${fusion ? "Fusion" : "ordinary"} session picks up a late connection, schema changes and removal`, async () => {
		const f = await fixture(fusion);
		try {
			expect(f.session.getActiveToolNames()).not.toContain("mcp__fake__echo");
			const snapshot = await f.connect();
			expect(f.session.getActiveToolNames()).toContain("mcp__fake__echo");
			await f.session.prompt("Use MCP");
			expect(f.calls()).toBe(1);
			await f.changeSchema();
			expect((f.session.getToolDefinition("mcp__fake__echo")!.parameters as any).required).toEqual(["new"]);
			await f.session.prompt("Use updated MCP");
			expect(f.calls()).toBe(2);
			f.readOnly();
			expect(f.session.getActiveToolNames()).not.toContain("mcp__fake__echo");
			await f.service.remove(snapshot.servers[0].config.id);
			expect(f.session.getToolDefinition("mcp__fake__echo")).toBeUndefined();
		} finally { await f.close(); }
	}, 30_000);

	test("Fusion reuses an unchanged MCP worker but recreates it after same-name schema changes or reconnect", async () => {
		const f = await fixture(true);
		try {
			const snapshot = await f.connect();
			const helper = f.workflow as unknown as { runHelper: (role: string, prompt: string, signal: undefined,
				scopes: string[], onStep: undefined, options: { reuseFusionWorker: boolean }) => Promise<string> };
			const run = () => helper.runHelper("agent", "Use MCP", undefined, [resolveWorkspacePath(f.cwd, ".")], undefined, { reuseFusionWorker: true });
			await run(); await run();
			const worker = (f.workflow as unknown as { sidekick: { session: AgentSession } }).sidekick.session;
			expect(worker.messages.filter((message) => message.role === "toolResult")).toEqual(
				expect.arrayContaining([expect.objectContaining({ toolName: "mcp__fake__echo", isError: false })]));
			expect(f.calls()).toBe(2);
			expect(new Set(f.helperIds).size).toBe(1);
			await f.changeSchema();
			await run();
			expect(f.calls()).toBe(3);
			expect(new Set(f.helperIds).size).toBe(2);
			await f.service.reconnect(snapshot.servers[0].config.id);
			await run();
			expect(f.calls()).toBe(4);
			expect(new Set(f.helperIds).size).toBe(3);
		} finally { await f.close(); }
	}, 30_000);
});
