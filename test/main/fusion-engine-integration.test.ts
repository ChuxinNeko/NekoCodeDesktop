import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentSystemPrompt, type ToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../../src/main/workflow-runtime";
import { PiFusionSessionStore } from "../../src/main/fusion/pi-session-store";
import { FUSION_USAGE_ENTRY } from "../../src/main/fusion-usage";

describe("Desktop reference FusionEngine", () => {
	test("plans structurally, executes both capable lanes concurrently, then synthesizes once", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-engine-"));
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
				modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only");
			const lead = getModel("anthropic", "claude-opus-4-5")!, side = getModel("anthropic", "claude-sonnet-4-5")!;
			const stages: string[] = [], starts = new Set<string>();
			const counts = new Map<string, number>();
			const pending: (() => void)[] = [];
			let syntheses = 0;
			runtime.streamSimple = (model, context) => {
				const system = getCurrentSystemPrompt(context.messages);
				const stage = system.includes("structured plan") ? "plan" : system.includes("Reconcile the work") ? "synthesize" :
					model.id === lead.id ? "main" : "sidekick";
				stages.push(stage);
				const n = (counts.get(stage) ?? 0) + 1; counts.set(stage, n); expect(n).toBeLessThanOrEqual(2);
				if (stage === "synthesize") { syntheses++; expect(JSON.stringify(context.messages)).toContain("MAIN_RESULT");
					expect(JSON.stringify(context.messages)).toContain("SIDE_RESULT"); expect(starts.size).toBe(2); }
				if (stage === "main") expect(JSON.stringify(context.messages)).not.toContain("SIDE_RESULT");
				if (stage === "sidekick") expect(JSON.stringify(context.messages)).not.toContain("MAIN_RESULT");
				const call: ToolCall | undefined = stage === "plan" ? { type: "toolCall", id: "plan", name: "fusion_submit_plan", arguments: {
					complexity: 0.8, mainTask: "Write main.txt with main; report MAIN_RESULT", sidekickTasks: [{ profile: null, task: "Write side.txt with side; report SIDE_RESULT" }] } } :
					["main", "sidekick"].includes(stage) && n === 1 ? { type: "toolCall", id: `write-${stage}`, name: "write",
						arguments: { path: stage === "main" ? "main.txt" : "side.txt", content: stage } } : undefined;
				const stream = createAssistantMessageEventStream();
				const send = () => stream.push({ type: "done", reason: call ? "toolUse" : "stop", message: {
					...fauxAssistantMessage(""), api: model.api, provider: model.provider, model: model.id,
					content: call ? [call] : [{ type: "text", text: stage === "main" ? "MAIN_RESULT" : stage === "sidekick" ? "SIDE_RESULT" : "AUTHORITATIVE_FINAL" }],
					stopReason: call ? "toolUse" : "stop", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				} });
				if (["main", "sidekick"].includes(stage) && n === 1) {
					starts.add(stage); pending.push(send); if (starts.size === 2) pending.splice(0).forEach(fn => queueMicrotask(fn));
				} else queueMicrotask(send);
				return stream;
			};
			const manager = SessionManager.inMemory(cwd);
			created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime,
				sessionManager: manager, initialMode: "agent", getPermission: () => "auto", initialFusion: {
					leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`, leadThinkingLevel: "off", sidekickThinkingLevel: "off" },
				onChange: () => undefined, onModeChange: () => undefined });
			expect(created.workflow.fusion?.orchestration).toBe("engine");
			expect(created.session.getActiveToolNames()).toContain("write");
			expect(created.session.getActiveToolNames()).not.toContain("fusion_implement");
			await created.session.prompt("Write main.txt and side.txt. Do not run tests.");
			expect(await readFile(join(cwd, "main.txt"), "utf8")).toBe("main");
			expect(await readFile(join(cwd, "side.txt"), "utf8")).toBe("sidekick");
			expect(stages[0]).toBe("plan"); expect(stages.at(-1)).toBe("synthesize"); expect(syntheses).toBe(1);
			expect(created.workflow.state.snapshot().fusion?.status).toBe("complete");
			expect(created.workflow.state.snapshot().fusion?.events.some(event => event.type === "plan.completed")).toBe(true);
			expect(manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
			const store = new PiFusionSessionStore(manager);
			expect(store.latest()?.contexts.main.at(-1)?.content).toBe("AUTHORITATIVE_FINAL");
			expect(store.latest()?.contexts.sidekick.at(-1)?.content).toBe("SIDE_RESULT");
			const auxiliary = manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === FUSION_USAGE_ENTRY);
			expect(auxiliary).toHaveLength(3); // plan + two Sidekick calls; Main is canonical, never duplicated.
		} finally { created?.workflow.dispose(); created?.session.dispose(); await created?.workflow.whenSettled(); await rm(cwd, { recursive: true, force: true }); }
	}, 10000);
});
