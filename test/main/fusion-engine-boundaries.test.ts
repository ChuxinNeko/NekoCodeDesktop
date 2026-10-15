import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentSystemPrompt, type ToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../../src/main/workflow-runtime";
import { PiFusionSessionStore } from "../../src/main/fusion/pi-session-store";
import { PiFusionStageDriver } from "../../src/main/fusion/pi-stage-driver";

async function fixture(run: (runtime: ModelRuntime, created: Awaited<ReturnType<typeof createWorkflowSession>>, manager: SessionManager) => Promise<void>) {
	const cwd = await mkdtemp(join(tmpdir(), "fusion-boundary-"));
	let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
	try {
		await writeFile(join(cwd, "input.txt"), "read only");
		const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
			modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
		await runtime.setRuntimeApiKey("anthropic", "test-only");
		const lead = getModel("anthropic", "claude-opus-4-5")!, side = getModel("anthropic", "claude-sonnet-4-5")!;
		const manager = SessionManager.inMemory(cwd);
		created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime,
			sessionManager: manager, initialMode: "agent", getPermission: () => "auto", initialFusion: {
				strategy: "parallel", leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`, leadThinkingLevel: "off", sidekickThinkingLevel: "off" },
			onChange: () => undefined, onModeChange: () => undefined });
		await run(runtime, created, manager);
	} finally { created?.workflow.dispose(); created?.session.dispose(); await created?.workflow.whenSettled(); await rm(cwd, { recursive: true, force: true }); }
}

describe("PI shared engine boundaries", () => {
	test("enforces twenty model steps independently in execution and synthesis", async () => fixture(async (runtime, created) => {
		const counts: Record<string, number> = {};
		runtime.streamSimple = (model, context) => {
			const system = getCurrentSystemPrompt(context.messages);
			const stage = system.includes("structured plan") ? "plan" : system.includes("Reconcile the work") ? "synthesize" : model.id.includes("opus") ? "main" : "sidekick";
			counts[stage] = (counts[stage] ?? 0) + 1;
			const call: ToolCall = stage === "plan" ? { type: "toolCall", id: "plan", name: "fusion_submit_plan", arguments: {
				complexity: .5, mainTask: "Read input.txt", sidekickTasks: [{ profile: null, task: "Read input.txt" }] } } :
				{ type: "toolCall", id: `${stage}-${counts[stage]}`, name: "read", arguments: { path: "input.txt" } };
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message: { ...fauxAssistantMessage(""),
				api: model.api, provider: model.provider, model: model.id, content: [call], stopReason: "toolUse" } }));
			return stream;
		};
		await created.session.prompt("Read input.txt repeatedly");
		expect(counts).toEqual({ plan: 1, main: 20, sidekick: 20, synthesize: 20 });
		expect(created.session.isIdle).toBe(true);
	}), 10000);

	test("aborts both active lanes, releases busy state, and allows a fresh run", async () => fixture(async (runtime, created) => {
		const started = new Set<string>(), cancelled = new Set<string>();
		let bothStarted!: () => void;
		const barrier = new Promise<void>(resolve => { bothStarted = resolve; });
		let blocking = true;
		runtime.streamSimple = (model, context, options) => {
			const system = getCurrentSystemPrompt(context.messages);
			const stage = system.includes("structured plan") ? "plan" : system.includes("Reconcile the work") ? "synthesize" : model.id.includes("opus") ? "main" : "sidekick";
			const stream = createAssistantMessageEventStream();
			const message = { ...fauxAssistantMessage("completed"), api: model.api, provider: model.provider, model: model.id };
			if (stage === "plan") queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message: {
				...message, stopReason: "toolUse", content: [{ type: "toolCall", id: "plan", name: "fusion_submit_plan", arguments: {
					complexity: .5, mainTask: "Wait", sidekickTasks: [{ profile: null, task: "Wait" }] } }] } }));
			else if (blocking) {
				started.add(stage); if (started.size === 2) bothStarted();
				options?.signal?.addEventListener("abort", () => { cancelled.add(stage); stream.push({ type: "error", reason: "aborted",
					error: { ...message, stopReason: "aborted", errorMessage: "cancelled" } }); }, { once: true });
			} else queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
			return stream;
		};
		const pending = created.session.prompt("Wait for cancellation");
		const rejected = pending.then(() => undefined, error => error);
		await barrier; await created.session.abort(); expect(await rejected).toBeInstanceOf(Error); await created.workflow.whenSettled();
		expect([...cancelled].sort()).toEqual(["main", "sidekick"]);
		expect(created.session.isStreaming).toBe(false); expect(created.session.isIdle).toBe(true);
		blocking = false;
		await created.session.prompt("Finish this time");
		expect(created.workflow.state.snapshot().fusion?.status).toBe("complete");
	}), 10000);

	test("restores lane snapshots on a new store and follows PI branch history", async () => {
		const manager = SessionManager.inMemory(".");
		const store = new PiFusionSessionStore(manager), session = await store.create({ prompt: "task" });
		await Promise.all([store.append(session.id, "main", { role: "assistant", content: "main" }),
			store.append(session.id, "sidekick", { role: "assistant", content: "side" })]);
		const checkpoint = manager.getBranch().at(-1)!.id;
		await store.compact(session.id, "main", "later");
		expect(new PiFusionSessionStore(manager).latest()?.compactions.main).toBe(1);
		manager.branch(checkpoint);
		const restored = new PiFusionSessionStore(manager).latest()!;
		expect(restored.contexts).toEqual({ main: [{ role: "assistant", content: "main" }], sidekick: [{ role: "assistant", content: "side" }] });
		expect(restored.compactions.main).toBe(0);
		restored.contexts.main.length = 0;
		expect((await store.get(session.id))?.contexts.main).toHaveLength(1);
		manager.resetLeaf(); expect(store.latest()).toBeUndefined();
	});

	test("loads both lane contexts and routing metadata from the saved session file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-store-"));
		try {
			const manager = SessionManager.create(cwd, join(cwd, "sessions"));
			manager.appendMessage({ role: "user", content: "persist me", timestamp: Date.now() });
			const store = new PiFusionSessionStore(manager), session = await store.create({ prompt: "persist me" });
			await store.append(session.id, "main", { role: "assistant", content: "main result" });
			await store.append(session.id, "sidekick", { role: "assistant", content: "side result" });
			await store.update(session.id, { models: { main: "p/lead", sidekick: "p/side" }, sidekickFailures: 2 });
			const reopened = new PiFusionSessionStore(SessionManager.open(manager.getSessionFile()!));
			expect(reopened.latest()).toEqual(store.latest());
			expect((await reopened.get(session.id))?.contexts.sidekick[0].content).toBe("side result");
		} finally { await rm(cwd, { recursive: true, force: true }); }
	});

	test("preserves the user on planning failure and restores native settings", async () => fixture(async (runtime, created, manager) => {
		const settings = created.session.settingsManager;
		const compaction = settings.getCompactionSettings().enabled, warming = settings.getCacheWarmingMode();
		runtime.streamSimple = model => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: { ...fauxAssistantMessage("invalid plan"),
				api: model.api, provider: model.provider, model: model.id } }));
			return stream;
		};
		await expect(created.session.prompt("Do not lose this task")).rejects.toThrow();
		expect(manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		expect(created.workflow.state.snapshot().fusion?.status).toBe("failed");
		expect(created.session.isStreaming).toBe(false);
		expect(settings.getCompactionSettings().enabled).toBe(compaction); expect(settings.getCacheWarmingMode()).toBe(warming);
	}));

	test("restores native hooks and disposes actors when model setup fails", async () => fixture(async (_runtime, created) => {
		const parent = created.session, transform = parent.agent.transformContext, finish = parent.agent.finishTurn;
		let disposed = 0;
		const driver = new PiFusionStageDriver({ parent, createActor: async () => ({ ...parent, agent: parent.agent,
			abort: async () => {}, dispose: () => { disposed++; } }) as typeof parent,
			resolveModel: () => { throw new Error("missing model"); }, thinking: () => "off", allowedTools: () => [],
			onUsage: () => {}, onChange: () => {} });
		for (const role of ["main", "sidekick"] as const) await expect(driver.run({ kind: "execute", role,
			model: "missing/model", instructions: "task", messages: [] })).rejects.toThrow("missing model");
		expect(parent.agent.transformContext).toBe(transform); expect(parent.agent.finishTurn).toBe(finish);
		expect(driver.nativeMainActive).toBe(false); expect(driver.currentMainStage).toBeUndefined(); expect(disposed).toBe(1);
	}));
});
