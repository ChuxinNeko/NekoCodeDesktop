import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession, WorkflowRuntime } from "../../src/main/workflow-runtime";
import { savedFusion } from "../../src/main/fusion-config";
import { isFusionConfig } from "../../src/shared/fusion";
import { buildModePrompt, toolsForMode } from "../../src/main/prompt-library";

describe("Fusion independent lanes", () => {
	test("enabling Fusion in an existing session installs the parallel harness and automatically returns to Lead", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-enable-"));
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
				modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only");
			const lead = getModel("anthropic", "claude-opus-4-5")!;
			const side = getModel("anthropic", "claude-sonnet-4-5")!;
			let leadCalls = 0, sideCalls = 0;
			const leadIds: string[] = [], sideIds: string[] = [];
			let delivered!: () => void;
			const delivery = new Promise<void>(resolve => { delivered = resolve; });
			runtime.streamSimple = (model, context, options) => {
				let calls: ToolCall[] | undefined;
				if (model.id === lead.id) {
					leadIds.push(options?.sessionId ?? "missing");
					const n = ++leadCalls; expect(n).toBeLessThanOrEqual(4);
					if (n === 1) calls = [{ type: "toolCall", id: "implement", name: "fusion_implement", arguments: {
						instruction: "Write output.txt with done", path: "output.txt", acceptanceCriterion: "Output written", skipReason: "No tests requested" } }];
					if (JSON.stringify(context.messages).includes("后台任务状态更新")) delivered();
				} else {
					expect(model.id).toBe(side.id); sideIds.push(options?.sessionId ?? "missing");
					const n = ++sideCalls; expect(n).toBeLessThanOrEqual(3);
					calls = n === 1 ? [{ type: "toolCall", id: "write", name: "write", arguments: { path: "output.txt", content: "done" } }] :
						n === 2 ? [{ type: "toolCall", id: "report", name: "fusion_report", arguments: { outcome: "completed", summary: "Wrote output.txt",
							acceptance: [{ criterion: "Output written", status: "unverified", evidence: "No tests requested" }] } }] : undefined;
				}
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: {
					...fauxAssistantMessage("Done"), api: model.api, provider: model.provider, model: model.id,
					stopReason: calls ? "toolUse" : "stop", content: calls ?? [{ type: "text", text: "Done" }],
				} }));
				return stream;
			};
			created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime,
				sessionManager: SessionManager.inMemory(cwd), model: lead, thinkingLevel: "off", initialMode: "agent",
				getPermission: () => "auto", onChange: () => undefined, onModeChange: () => undefined });
			await created.workflow.setFusion({ orchestration: "parallel", leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`,
				leadThinkingLevel: "off", sidekickThinkingLevel: "off" });
			expect(created.workflow.fusion?.orchestration).toBe("parallel");
			await created.session.prompt("Write output.txt. No tests.");
			await created.workflow.whenSettled();
			await delivery;
			expect(await readFile(join(cwd, "output.txt"), "utf8")).toBe("done");
			expect(new Set(leadIds).size).toBe(1);
			expect(new Set(sideIds).size).toBe(1);
			expect(leadIds[0]).not.toBe(sideIds[0]);
			expect(created.session.model?.id).toBe(lead.id);
		} finally { created?.workflow.dispose(); created?.session.dispose(); await created?.workflow.whenSettled(); await rm(cwd, { recursive: true, force: true }); }
	}, 10000);

	test("normalizes saved configurations to the shared engine while preserving explicit internal parallel tools", () => {
		const config = { leadModelKey: "p/lead", sidekickModelKey: "p/side", leadThinkingLevel: "off", sidekickThinkingLevel: "off" };
		expect(isFusionConfig({ ...config, orchestration: "invalid" })).toBe(false);
		const manager = SessionManager.inMemory(process.cwd());
		manager.appendCustomEntry("nekocode.fusion.v1", config);
		expect(savedFusion(manager)?.orchestration).toBe("engine");
		manager.appendCustomEntry("nekocode.fusion.v1", { ...config, orchestration: "parallel" });
		expect(savedFusion(manager)?.orchestration).toBe("engine");
		const context = { mode: "agent" as const, permission: "auto" as const, phase: "execute" as const,
			fusionAgent: "main" as const, fusionModelRole: "lead" as const, fusionOrchestration: "parallel" as const };
		expect(toolsForMode(context)).toContain("task");
		expect(toolsForMode(context)).toContain("fusion_implement");
		expect(buildModePrompt(context)).toContain("独立且可复用");
		expect(buildModePrompt(context)).not.toContain("Lead/Sidekick 是同一主会话");
		expect(toolsForMode({ ...context, permission: "read-only" })).not.toContain("fusion_implement");
		expect(toolsForMode({ ...context, permission: "read-only" })).toContain("fusion_investigate");
	});

	test("isolates Lead history, reuses investigation history for execution, and delivers each result once", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-parallel-"));
		let workflow: WorkflowRuntime | undefined;
		try {
			await writeFile(join(cwd, "source.txt"), "SIDEKICK_OBSERVED_EVIDENCE");
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
				modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only");
			const lead = getModel("anthropic", "claude-opus-4-5")!;
			const side = getModel("anthropic", "claude-sonnet-4-5")!;
			let round = 0;
			let releaseRead: (() => void) | undefined;
			const ids: string[] = [];
			runtime.streamSimple = (model, context, options) => {
				expect(model.id).toBe(side.id);
				ids.push(options?.sessionId ?? "missing");
				const n = ++round;
				expect(n).toBeLessThanOrEqual(5);
				expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_LEAD_TRANSCRIPT");
				if (n === 3) expect(JSON.stringify(context.messages)).toContain("SIDEKICK_OBSERVED_EVIDENCE");
				const calls: ToolCall[] | undefined = n === 1 ? [{ type: "toolCall", id: "read", name: "read", arguments: { path: "source.txt" } }] :
					n === 3 ? [
						{ type: "toolCall", id: "outside", name: "write", arguments: { path: "outside.txt", content: "forbidden" } },
						{ type: "toolCall", id: "write", name: "write", arguments: { path: "result.txt", content: "implemented" } },
					] : n === 4 ? [{ type: "toolCall", id: "report", name: "fusion_report", arguments: {
						outcome: "completed", summary: "result.txt written; verification skipped", acceptance: [
							{ criterion: "Output exists", status: "unverified", evidence: "User forbids tests" }] } }] : undefined;
				const stream = createAssistantMessageEventStream();
				const send = () => stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: {
					...fauxAssistantMessage("Evidence ready"), provider: model.provider, model: model.id, api: model.api,
					stopReason: calls ? "toolUse" : "stop", content: calls ?? [{ type: "text", text: "Evidence ready" }],
				} });
				if (n === 1) releaseRead = send; else queueMicrotask(send);
				return stream;
			};
			const manager = SessionManager.inMemory(cwd);
			manager.appendMessage({ role: "user", content: "Write result.txt. Do not run tests.", timestamp: 1 });
			const notices: unknown[] = [];
			workflow = new WorkflowRuntime({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime,
				sessionManager: manager, initialMode: "agent", getPermission: () => "auto",
				initialFusion: { orchestration: "parallel", leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`,
					leadThinkingLevel: "off", sidekickThinkingLevel: "off" }, onChange: () => undefined, onModeChange: () => undefined });
			const parent = { model: lead, messages: [{ role: "user", content: "PRIVATE_LEAD_TRANSCRIPT", timestamp: 1 }], agent: {},
				setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
				sendCustomMessage: async (message: unknown) => { notices.push(message); } } as unknown as AgentSession;
			workflow.attach(parent);
			const investigate = workflow.tools().find(tool => tool.name === "fusion_investigate")!;
			await investigate.execute("investigate", { instruction: "Read source.txt and return facts; no editing." }, undefined, undefined, {} as never);
			// Assignment returns while its model is still running; Lead retains its own context and model.
			for (let i = 0; i < 100 && !releaseRead; i++) await new Promise(resolve => setTimeout(resolve, 5));
			expect(releaseRead).toBeDefined();
			expect(workflow.state.hasRunningTasks).toBe(true);
			expect(parent.model?.id).toBe(lead.id);
			expect(workflow.context().fusionModelRole).toBe("lead");
			await expect(investigate.execute("second", { instruction: "Read another file" }, undefined, undefined, {} as never)).rejects.toThrow("At most 1");
			releaseRead!();
			await workflow.whenSettled();
			const implement = workflow.tools().find(tool => tool.name === "fusion_implement")!;
			await implement.execute("implement", { instruction: "Write result.txt with implemented", path: "result.txt",
				acceptanceCriterion: "Output exists", skipReason: "User forbids tests" }, undefined, undefined, {} as never);
			await workflow.whenSettled();
			expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("implemented");
			await expect(readFile(join(cwd, "outside.txt"))).rejects.toThrow();
			expect(new Set(ids).size).toBe(1);
			expect(notices).toHaveLength(2);
			expect(workflow.state.snapshot().tasks.map(task => task.status)).toEqual(["completed", "completed"]);
			expect(workflow.context().fusionModelRole).toBe("lead");
		} finally { workflow?.dispose(); await workflow?.whenSettled(); await rm(cwd, { recursive: true, force: true }); }
	}, 30000);
});
