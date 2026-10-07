import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { WorkflowRuntime } from "../../src/main/workflow-runtime";
import type { TaskInput } from "../../src/shared/workflow";
import { FUSION_USAGE_ENTRY, type FusionUsageRecord } from "../../src/main/fusion-usage";

// Real SDK/tool loop and real temporary files. Only the external model response is scripted.
describe("Fusion Sidekick task integration", () => {
	test("reuses history but cannot write into a previous task's scope", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-worker-"));
		let workflow: WorkflowRuntime | undefined;
		try {
			const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
				modelsStorePath: join(cwd, "models-store.json"), allowModelNetwork: false });
			await modelRuntime.setRuntimeApiKey("anthropic", "test-only");
			const model = getModel("anthropic", "claude-sonnet-4-5")!;
			const leadModel = getModel("anthropic", "claude-opus-4-5")!;
			const selectedModels: string[] = [];
			const manager = SessionManager.inMemory(cwd);
			manager.appendMessage({ role: "user", content: "Implement two changes", timestamp: 100 });
			let round = 0;
			let permission: "auto" | "read-only" = "auto";
			const sessionIds: string[] = [];
			let sawOldHistory = false;
			modelRuntime.streamSimple = (selected, context, options) => {
				selectedModels.push(`${selected.provider}/${selected.id}`);
				const stream = createAssistantMessageEventStream();
				sessionIds.push(options?.sessionId ?? "missing");
				const current = ++round;
				if (current === 7) permission = "read-only";
				if (current === 4) sawOldHistory = JSON.stringify(context.messages).includes("first-result");
				const calls = current === 7 ? [{ type: "toolCall" as const, id: "readonly", name: "write", arguments: { path: "b.txt", content: "forbidden-readonly" } }] : current === 1 ? [{ type: "toolCall" as const, id: "write-a", name: "write", arguments: { path: "a.txt", content: "original" } }] :
					current === 4 ? [{ type: "toolCall" as const, id: "outside", name: "write", arguments: { path: "a.txt", content: "forbidden" } },
						{ type: "toolCall" as const, id: "write-b", name: "write", arguments: { path: "b.txt", content: "second" } }] :
					current === 2 || current === 5 ? [{ type: "toolCall" as const, id: `report-${current}`, name: "fusion_report", arguments: {
						outcome: "completed", summary: "Implementation ready", acceptance: [{ criterion: "file exists", status: "unverified", evidence: "No tests requested" }],
					} }] : undefined;
				queueMicrotask(() => stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: {
					...fauxAssistantMessage(current === 3 ? "first-result" : "second-result"),
					api: selected.api, provider: selected.provider, model: selected.id,
					content: calls ?? [{ type: "text", text: current === 3 ? "first-result" : "second-result" }],
					stopReason: calls ? "toolUse" : "stop", timestamp: current,
					usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
						cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
				} }));
				return stream;
			};
			workflow = new WorkflowRuntime({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime,
				sessionManager: manager, initialMode: "agent", getPermission: () => permission,
				initialFusion: { leadModelKey: `${leadModel.provider}/${leadModel.id}`, sidekickModelKey: `${model.provider}/${model.id}`,
					leadThinkingLevel: "off", sidekickThinkingLevel: "off" },
				onChange: () => undefined, onModeChange: () => undefined,
			});
			workflow.attach({ model: leadModel, messages: [{ role: "user", timestamp: 100 }], agent: {},
				setActiveToolsByName: () => undefined, sendCustomMessage: async () => undefined,
			} as unknown as AgentSession);
			const input = (path: string): TaskInput => ({ kind: "worker", description: path, prompt: `Write ${path}.`, writablePaths: [path],
				executionPlan: { steps: [`Write ${path}`], constraints: ["Skip validation in this test"], acceptanceCriteria: ["file exists"],
					verification: { mode: "skip", checks: [] } } });
			workflow.state.startTask(input("a.txt")); await workflow.whenSettled();
			workflow.state.startTask(input("b.txt")); await workflow.whenSettled();
			expect(sawOldHistory).toBe(true);
			expect(new Set(selectedModels)).toEqual(new Set([`${model.provider}/${model.id}`]));
			expect(new Set(sessionIds).size).toBe(1);
			expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("original");
			expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("second");
			const tasks = workflow.state.snapshot().tasks;
			expect(tasks.map((task) => task.outcome)).toEqual(["completed", "completed"]);
			expect(tasks[1].result).toContain("outside the worker");
			const records = () => manager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === FUSION_USAGE_ENTRY
				? [entry.data as FusionUsageRecord] : []);
			expect(records()).toHaveLength(6);
			expect(new Set(records().map((entry) => entry.taskId)).size).toBe(2);
			// Simulate the SDK's warming usage event after a new Lead prompt arrives, before Sidekick starts it.
			manager.appendMessage({ role: "user", content: "Next request", timestamp: 200 });
			const side = (workflow as unknown as { sidekick: { session: AgentSession } }).sidekick.session;
			const warm = side.sessionManager.appendUsage("cache_warm", model.provider, model.id, {
				input: 0, output: 1, cacheRead: 20, cacheWrite: 0, totalTokens: 21,
				cost: { input: 0, output: 0.001, cacheRead: 0.002, cacheWrite: 0, total: 0.003 },
			});
			const emit = (side as unknown as { _emit: (event: AgentSessionEvent) => void })._emit.bind(side);
			emit({ type: "entry_appended", entry: warm }); emit({ type: "entry_appended", entry: warm });
			expect(records()).toHaveLength(7);
			expect(records().at(-1)).toMatchObject({ kind: "cache-warm", turnTimestamp: 100, taskId: tasks[1].id });
			workflow.state.startTask(input("b.txt")); await workflow.whenSettled();
			expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("second");
			expect(workflow.state.snapshot().tasks.at(-1)?.outcome).toBe("needs_decision");
			expect(() => workflow!.state.startTask(input("b.txt"))).toThrow("read-only permission");
		} finally {
			workflow?.dispose(); await workflow?.whenSettled();
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30000);

	test("upgrades only at a natural compaction boundary when the user enabled routing", async () => {
		for (const adaptiveRouting of [true, false]) {
			const cwd = await mkdtemp(join(tmpdir(), "fusion-routing-"));
			let workflow: WorkflowRuntime | undefined;
			try {
				const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
					modelsStorePath: join(cwd, "models-store.json"), allowModelNetwork: false });
				await modelRuntime.setRuntimeApiKey("anthropic", "test-only");
				const side = getModel("anthropic", "claude-sonnet-4-5")!;
				const lead = getModel("anthropic", "claude-opus-4-5")!;
				const manager = SessionManager.inMemory(cwd);
				manager.appendMessage({ role: "user", content: "Implement", timestamp: 1 });
				// Small fixture history needs a small retention budget to have a real cut point.
				await mkdir(join(cwd, "agent"));
				await writeFile(join(cwd, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
				const requested: string[] = [];
				let executionSessionId: string | undefined;
				modelRuntime.streamSimple = (model, _context, options) => {
					const stream = createAssistantMessageEventStream();
					// Summaries receive their own routing/cache identity, not an absent sessionId.
					const summary = executionSessionId !== undefined && options?.sessionId !== executionSessionId;
					if (!executionSessionId) executionSessionId = options?.sessionId;
					if (!summary) requested.push(model.id);
					const call: ToolCall | undefined = !summary && requested.length === 1 ? {
						type: "toolCall" as const, id: "upgrade", name: "fusion_request_upgrade",
						arguments: { reason: "Cannot establish invariant", evidence: "Cancellation conflicts with transaction guarantee" },
					} : !summary && requested.length === 2 ? {
						type: "toolCall" as const, id: "report", name: "fusion_report", arguments: { outcome: "completed",
							summary: "Ready for Lead", acceptance: [{ criterion: "Preserve invariant", status: "unverified", evidence: "Review required" }] },
					} : undefined;
					const input = !summary && requested.length === 1 ? side.contextWindow : 10;
					queueMicrotask(() => stream.push({ type: "done", reason: call ? "toolUse" : "stop", message: {
						...fauxAssistantMessage(summary ? "summary" : "done"), api: model.api, provider: model.provider, model: model.id,
						content: call ? [call] : [{ type: "text", text: summary ? "summary" : "done" }], stopReason: call ? "toolUse" : "stop",
						usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					} })); return stream;
				};
				workflow = new WorkflowRuntime({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime,
					sessionManager: manager, initialMode: "agent", getPermission: () => "auto",
					initialFusion: { leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`,
						leadThinkingLevel: "off", sidekickThinkingLevel: "off", adaptiveRouting },
					onChange: () => undefined, onModeChange: () => undefined });
				workflow.attach({ model: lead, messages: [{ role: "user", timestamp: 1 }], agent: {},
					setActiveToolsByName: () => undefined, sendCustomMessage: async () => undefined } as unknown as AgentSession);
				workflow.state.startTask({ kind: "worker", description: "Fix", prompt: "Implement", writablePaths: ["."],
					executionPlan: { steps: ["Implement invariant"], constraints: ["Skip checks in fixture"], acceptanceCriteria: ["Preserve invariant"],
						verification: { mode: "skip", checks: [] } } });
				await workflow.whenSettled();
				expect(requested).toEqual([side.id, adaptiveRouting ? lead.id : side.id, adaptiveRouting ? lead.id : side.id]);
				const records = manager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === FUSION_USAGE_ENTRY
					? [entry.data as FusionUsageRecord] : []);
				expect(records.some((entry) => entry.kind === "compaction")).toBe(true);
				expect(records.filter((entry) => entry.kind === "compaction").every((entry) => entry.usage.model === side.id)).toBe(true);
				expect(workflow.state.snapshot().tasks[0].outcome).toBe("completed");
			} finally { workflow?.dispose(); await workflow?.whenSettled(); await rm(cwd, { recursive: true, force: true }); }
		}
	}, 30000);
});
