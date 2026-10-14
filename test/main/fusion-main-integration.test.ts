import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentSystemPrompt, type ToolCall, type Message } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowSession } from "../../src/main/workflow-runtime";
import { projectMessages } from "../../src/main/agent-projection";
import { withFusionUsage } from "../../src/main/fusion-usage";
import { FileJournalRecorder } from "../../src/main/file-journal-recorder";
import { CHECKPOINT_ENTRY, turnStats } from "../../src/main/file-journal";
import { cellIdForMessage, findTurnEntry } from "../../src/main/checkpoint-anchor";
import { FUSION_RUN_ENTRY } from "../../src/main/fusion-resilience";

describe("Fusion inline main conversation", () => {
	for (const permission of ["auto", "read-only"] as const) test(`investigation -> Lead decision -> scoped execution -> Lead acceptance (${permission})`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-investigate-"));
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			await writeFile(join(cwd, "source.txt"), "observed source");
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only");
			const lead = getModel("anthropic", "claude-opus-4-5")!;
			const side = getModel("anthropic", "claude-sonnet-4-5")!;
			const selected: string[] = []; const sessionIds: string[] = []; let round = 0;
			runtime.streamSimple = (model, context, options) => {
				const n = ++round; selected.push(model.id); sessionIds.push(options?.sessionId ?? "missing");
				expect(n).toBeLessThanOrEqual(permission === "auto" ? 8 : 5);
				if (n === 2) {
					for (const name of ["write", "bash", "task", "code_search"]) expect(created!.session.getActiveToolNames()).not.toContain(name);
					expect(getCurrentSystemPrompt(context.messages)).toContain("同会话 Sidekick 只读调查");
				}
				if (n === 6) expect(JSON.stringify(context.messages)).toContain("skipReason takes precedence");
				if (n === 5) {
					expect(JSON.stringify(context.messages)).toContain("source.txt: observed source");
					expect(JSON.stringify(context.messages)).toContain("YOU ARE NOW LEAD");
					expect(getCurrentSystemPrompt(context.messages)).not.toContain("同会话 Sidekick 只读调查");
				}
				const calls: ToolCall[] | undefined = n === 1 ? [{ type: "toolCall", id: "investigate", name: "fusion_investigate", arguments: { instruction: "Read source.txt and return the observed literal; do not choose a replacement" } }] :
					n === 2 ? [{ type: "toolCall", id: "read-source", name: "read", arguments: { path: "source.txt" } }] :
					n === 3 ? [{ type: "toolCall", id: "denied-write", name: "write", arguments: { path: "source.txt", content: "unauthorized" } }] :
					n === 4 ? [{ type: "toolCall", id: "facts", name: "fusion_review", arguments: { outcome: "completed", summary: "source.txt: observed source", acceptance: [] } }] :
					n === 5 && permission === "auto" ? [{ type: "toolCall", id: "implement", name: "fusion_implement", arguments: { instruction: "Lead chooses the literal decided", path: "result.txt", acceptanceCriterion: "Lead literal", check: "Do not execute this conflicting check", skipReason: "No test execution needed" } }] :
					n === 6 ? [{ type: "toolCall", id: "write-result", name: "write", arguments: { path: "result.txt", content: "decided" } }] :
					n === 7 ? [{ type: "toolCall", id: "review", name: "fusion_review", arguments: { outcome: "completed", summary: "result.txt written" } }] : undefined;
				const stream = createAssistantMessageEventStream(); queueMicrotask(() => stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: {
					...fauxAssistantMessage("Lead reviewed"), provider: model.provider, model: model.id, api: model.api, stopReason: calls ? "toolUse" : "stop", content: calls ?? [{ type: "text", text: "Lead reviewed" }],
				} })); return stream;
			};
			created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime,
				sessionManager: SessionManager.inMemory(cwd), initialMode: "agent", getPermission: () => permission,
				initialFusion: { orchestration: "inline" as const, leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`, leadThinkingLevel: "off", sidekickThinkingLevel: "off" },
				onChange: () => undefined, onModeChange: () => undefined });
			await created.session.prompt("Inspect source.txt; Lead decides whether to create result.txt.");
			expect(selected).toEqual(permission === "auto" ? [lead.id, side.id, side.id, side.id, lead.id, side.id, side.id, lead.id] : [lead.id, side.id, side.id, side.id, lead.id]);
			expect(new Set(sessionIds).size).toBe(1);
			expect(created.workflow.state.snapshot().tasks).toEqual([]);
			expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("observed source");
			if (permission === "auto") expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("decided");
			else await expect(readFile(join(cwd, "result.txt"))).rejects.toThrow();
			expect(created.session.messages.some((m) => m.role === "toolResult" && m.toolCallId === "denied-write" && m.isError)).toBe(true);
		} finally { created?.workflow.dispose(); created?.session.dispose(); await rm(cwd, { recursive: true, force: true }); }
	}, 30000);
	test("repeated requests for unavailable Lead write tools terminate with an explicit blocker", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-breaker-"));
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only"); const lead = getModel("anthropic", "claude-opus-4-5")!;
			let requests = 0; const errors: string[] = [];
			runtime.streamSimple = (model) => { requests++; expect(requests).toBeLessThanOrEqual(3);
				const stream = createAssistantMessageEventStream(); queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message: {
					...fauxAssistantMessage(""), provider: model.provider, model: model.id, api: model.api, stopReason: "toolUse",
					content: [{ type: "toolCall", id: `write-${requests}`, name: "write", arguments: { path: "forbidden.ts", content: "bad" } }],
				} })); return stream; };
			created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime,
				sessionManager: SessionManager.inMemory(cwd), initialMode: "agent", getPermission: () => "auto",
				initialFusion: { orchestration: "inline" as const, leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${lead.provider}/${lead.id}`, leadThinkingLevel: "off", sidekickThinkingLevel: "off" },
				onChange: () => undefined, onModeChange: () => undefined, onError: (error) => errors.push(error) });
			await created.session.prompt("Implement the scoped task."); expect(requests).toBe(3);
			expect(errors.some((error) => error.includes("three consecutive failed"))).toBe(true);
			await expect(readFile(join(cwd, "forbidden.ts"))).rejects.toThrow();
		} finally { created?.workflow.dispose(); created?.session.dispose(); await rm(cwd, { recursive: true, force: true }); }
	}, 30000);
	test("cancel, reload and continue preserve the plan, scope and cumulative task counters", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-reload-"));
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only");
			const lead = getModel("anthropic", "claude-opus-4-5")!; const side = getModel("anthropic", "claude-sonnet-4-5")!;
			const manager = SessionManager.inMemory(cwd); let round = 0; const selected: string[] = [];
			runtime.streamSimple = (model) => {
				const n = ++round; selected.push(model.id); expect(n).toBeLessThanOrEqual(7);
				const calls: ToolCall[] | undefined = n === 1 ? [{ type: "toolCall", id: "handoff", name: "fusion_implement", arguments: {
					instruction: "Write review.md from the agreed evidence", path: "review.md", acceptanceCriterion: "Cited review", skipReason: "No tests" } }] :
					n === 2 || n === 5 ? [{ type: "toolCall", id: `write-${n}`, name: "write", arguments: { path: "review.md", content: n === 2 ? "draft" : "final cited review" } }] :
					n === 4 ? [{ type: "toolCall", id: "resume", name: "fusion_implement", arguments: { resume: true,
						instruction: "Write final cited review", resolution: "Keep the restored scope and original acceptance" } }] :
					n === 6 ? [{ type: "toolCall", id: "review", name: "fusion_review", arguments: { outcome: "completed", summary: "Final review written",
						acceptance: [{ criterion: "Cited review", status: "unverified", evidence: "No API measurements" }] } }] : undefined;
				if (n === 3) created!.workflow.stop();
				const stream = createAssistantMessageEventStream(); queueMicrotask(() => stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: {
					...fauxAssistantMessage(""), provider: model.provider, model: model.id, api: model.api, stopReason: calls ? "toolUse" : "stop",
					content: calls ?? [{ type: "text", text: n === 3 ? "Paused without acceptance" : "Reviewed" }],
				} })); return stream;
			};
			const options = { cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime, sessionManager: manager,
				initialMode: "agent" as const, getPermission: () => "auto" as const, onChange: () => undefined, onModeChange: () => undefined };
			created = await createWorkflowSession({ ...options, initialFusion: { orchestration: "inline" as const, leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`, leadThinkingLevel: "off", sidekickThinkingLevel: "off" } });
			await created.session.prompt("审查代码并生成 review.md，不测试。"); expect(round).toBe(3);
			const state = () => { const entry = [...manager.getBranch()].reverse().find((item) => item.type === "custom" && item.customType === FUSION_RUN_ENTRY);
				return entry?.type === "custom" ? entry.data as { objective: string; progress: { requests: number }; inline: { previous: { writablePaths: string[] } } } : undefined; };
			const before = state()!; expect(before.inline.previous.writablePaths).toEqual(["review.md"]);
			created.workflow.dispose(); created.session.dispose();
			created = await createWorkflowSession({ ...options, initialFusion: { orchestration: "inline", leadModelKey: `${lead.provider}/${lead.id}`,
				sidekickModelKey: `${side.provider}/${side.id}`, leadThinkingLevel: "off", sidekickThinkingLevel: "off" } });
			expect(created.workflow.context().fusionDocumentReview).toBe(true);
			await created.session.prompt("继续，保留已写入内容和未提交修改。");
			expect(await readFile(join(cwd, "review.md"), "utf8")).toBe("final cited review");
			expect(selected).toEqual([lead.id, side.id, side.id, lead.id, side.id, side.id, lead.id]);
			expect(state()!.objective).toBe(before.objective); expect(state()!.progress.requests).toBe(7);
		} finally { created?.workflow.dispose(); created?.session.dispose(); await rm(cwd, { recursive: true, force: true }); }
	}, 30000);
	test("document budgets cover Lead discovery, Sidekick assembly and a concrete correction", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-document-"));
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			await writeFile(join(cwd, "source.ts"), "export const value = 1;\n");
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
				modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only");
			const lead = getModel("anthropic", "claude-opus-4-5")!;
			const side = getModel("anthropic", "claude-sonnet-4-5")!;
			let round = 0;
			let searches = 0;
			const selected: string[] = [];
			runtime.streamSimple = (model, context) => {
				const n = ++round; selected.push(model.id); expect(n).toBeLessThanOrEqual(7);
				if (n === 2) {
					expect(created!.session.getActiveToolNames()).not.toContain("read");
					expect(created!.session.getActiveToolNames()).not.toContain("code_search");
					expect(created!.session.getActiveToolNames()).toContain("fusion_implement");
				}
				if (n === 3) expect(getCurrentSystemPrompt(context.messages)).toContain("文档成文阶段");
				if (n === 4) {
					expect(JSON.stringify(context.messages)).toContain("investigation budget exhausted");
					expect(JSON.stringify(context.messages)).toContain("acceptance is unverified");
				}
				const calls: ToolCall[] | undefined = n === 1 ? [
					...Array.from({ length: 2 }, (_, i) => ({ type: "toolCall" as const, id: `locate-${i}`, name: "code_search", arguments: { query: "Locate source.ts value" } })),
					...Array.from({ length: 13 }, (_, i) => ({ type: "toolCall" as const, id: `lead-read-${i}`, name: "read", arguments: { path: "source.ts" } })),
					{ type: "toolCall", id: "excess-search", name: "code_search", arguments: { query: "Locate README architecture" } },
				] : n === 2 ? [{ type: "toolCall", id: "handoff", name: "fusion_implement", arguments: {
					instruction: "Write review.md using shared evidence", path: "review.md", acceptanceCriterion: "Cited review", skipReason: "No tests requested" } }] :
					n === 3 ? Array.from({ length: 13 }, (_, i) => ({ type: "toolCall" as const, id: `read-${i}`, name: "read",
						arguments: { path: "source.ts" } })) :
					n === 4 ? [{ type: "toolCall", id: "resume", name: "fusion_implement", arguments: {
						resume: true, instruction: "Write the review now with source.ts:1", resolution: "value is 1; actual API savings are unverified" } }] :
					n === 5 ? [{ type: "toolCall", id: "write", name: "write", arguments: { path: "review.md", content: "source.ts:1 value=1. API savings unverified." } }] :
					n === 6 ? [{ type: "toolCall", id: "review", name: "fusion_review", arguments: {
						outcome: "completed", summary: "Wrote cited review", acceptance: [
							{ criterion: "Cited review", status: "met", evidence: "write succeeded; citation source.ts:1" }] } }] : undefined;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: {
					...fauxAssistantMessage("Reviewed"), api: model.api, provider: model.provider, model: model.id,
					stopReason: calls ? "toolUse" : "stop", content: calls ?? [{ type: "text", text: "Reviewed" }],
				} }));
				return stream;
			};
			created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd,
				modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd), initialMode: "agent", getPermission: () => "auto",
				initialFusion: { orchestration: "inline" as const, leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`,
					leadThinkingLevel: "off", sidekickThinkingLevel: "off", adaptiveRouting: true },
				onChange: () => undefined, onModeChange: () => undefined });
			created.workflow.searchCode = async () => { searches++; return "source.ts:1 export const value = 1;"; };
			await created.session.prompt("Review source.ts and write only review.md. No tests.");
			expect(searches).toBe(0); // Independent helpers are unavailable in default Fusion execution.
			expect(created.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error")
				.map((message) => message.role === "assistant" ? message.errorMessage : "")).toEqual([]);
			expect(selected).toEqual([lead.id, lead.id, side.id, lead.id, side.id, side.id, lead.id]);
			expect(await readFile(join(cwd, "review.md"), "utf8")).toContain("API savings unverified");
			expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe("export const value = 1;\n");
			expect(created.session.messages.some((message) => message.role === "toolResult" && message.toolCallId === "read-12" && message.isError)).toBe(true);
			for (const id of ["lead-read-12", "excess-search"]) expect(created.session.messages.some((message) =>
				message.role === "toolResult" && message.toolCallId === id && message.isError)).toBe(true);
			expect(created.session.sessionManager.getBranch().some((entry) => entry.type === "custom_message" &&
				entry.customType === "nekocode.fusion.document-return.v1")).toBe(true);
		} finally {
			created?.workflow.dispose(); created?.session.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30000);
	test("compact handoff and resume reuse scope and keep the prior Lead request prefix", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-resume-"));
		let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
				modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only");
			const lead = getModel("anthropic", "claude-opus-4-5")!;
			const side = getModel("anthropic", "claude-sonnet-4-5")!;
			let round = 0;
			let leadPrefix: Message[] = [];
			const selected: string[] = [];
			runtime.streamSimple = (model, context) => {
				const n = ++round; selected.push(model.id); expect(n).toBeLessThanOrEqual(7);
				if (n === 4) leadPrefix = JSON.parse(JSON.stringify(context.messages));
				if (n === 5) {
					expect(JSON.stringify(context.messages)).toContain("Use the corrected literal");
					expect(JSON.stringify(context.messages)).toContain("RAW_IMPLEMENTATION_BODY");
				}
				if (n === 7) {
					expect(context.messages.slice(0, leadPrefix.length)).toEqual(leadPrefix);
					expect(JSON.stringify(context.messages)).not.toContain("RAW_IMPLEMENTATION_BODY");
				}
				const calls: ToolCall[] | undefined = n === 1 ? [{ type: "toolCall", id: "compact", name: "fusion_implement", arguments: {
					instruction: "Write a.txt", path: "a.txt", acceptanceCriterion: "Correct literal", skipReason: "User forbids tests" } }] :
					n === 2 || n === 5 ? [{ type: "toolCall", id: `write-${n}`, name: "write", arguments: {
						path: "a.txt", content: n === 2 ? "RAW_IMPLEMENTATION_BODY".repeat(1500) : "fixed" } }] :
					n === 3 || n === 6 ? [{ type: "toolCall", id: `review-${n}`, name: "fusion_review", arguments: {
						outcome: n === 3 ? "needs_decision" : "completed", summary: "Review literal", acceptance: [
							{ criterion: "Correct literal", status: "unverified", evidence: "No tests requested" }],
						...(n === 3 ? { decision: "Which literal should be used?" } : {}) } }] :
					n === 4 ? [{ type: "toolCall", id: "resume", name: "fusion_implement", arguments: {
						resume: true, instruction: "Use the corrected literal", resolution: "The agreed literal is fixed" } }] : undefined;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: {
					...fauxAssistantMessage("Reviewed"), api: model.api, provider: model.provider, model: model.id,
					usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 130,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: calls ? "toolUse" : "stop", content: calls ?? [{ type: "text", text: "Reviewed" }],
				} }));
				return stream;
			};
			created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd,
				modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd), initialMode: "agent", getPermission: () => "auto",
				initialFusion: { orchestration: "inline" as const, leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`,
					leadThinkingLevel: "off", sidekickThinkingLevel: "off", adaptiveRouting: true },
				onChange: () => undefined, onModeChange: () => undefined });
			const checkpointId = created.session.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY, { label: "Edit a.txt" });
			const journal = new FileJournalRecorder(cwd);
			journal.attach(created.session);
			await created.session.prompt("Write a.txt. Do not run tests.");
			expect(selected).toEqual([lead.id, side.id, side.id, lead.id, side.id, side.id, lead.id]);
			expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("fixed");
			const usage = withFusionUsage(projectMessages(created.session.messages), created.session.sessionManager.getBranch())
				.flatMap((cell) => cell.type === "assistant" && cell.usage ? [cell.usage] : []).at(-1)!;
			expect(usage.totalTokens).toBe(910);
			expect(usage.fusion?.lead.calls).toBe(3);
			expect(usage.fusion?.lead.totalTokens).toBe(390);
			expect(usage.fusion?.sidekick.usage?.calls).toBe(4);
			expect(usage.fusion?.sidekick.usage?.totalTokens).toBe(520);
			const branch = created.session.sessionManager.getBranch();
			expect(turnStats(branch, checkpointId).list.map((file) => file.path)).toEqual(["a.txt"]);
			const prompt = findTurnEntry(branch, checkpointId);
			expect(prompt?.message?.role).toBe("user");
			const cellId = cellIdForMessage(created.session.messages, prompt?.message ?? undefined);
			expect(projectMessages(created.session.messages).some((cell) => cell.type === "user" && cell.id === cellId)).toBe(true);
		} finally {
			created?.workflow.dispose(); created?.session.dispose();
			await created?.workflow.whenSettled(); await rm(cwd, { recursive: true, force: true });
		}
	}, 30000);
	for (const adaptiveRouting of [true, false]) for (const sameModel of [true, false]) for (const handoff of ["report", "missing", "stop"] as const) {
		const report = handoff === "report";
		test(`Lead -> Sidekick -> Lead without a worker (adaptive=${adaptiveRouting}, same=${sameModel}, handoff=${handoff})`, async () => {
			const cwd = await mkdtemp(join(tmpdir(), "fusion-main-"));
			let created: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
			try {
				const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
					modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
				await runtime.setRuntimeApiKey("anthropic", "test-only");
				const lead = getModel("anthropic", "claude-opus-4-5")!;
				const side = sameModel ? lead : getModel("anthropic", "claude-sonnet-4-5")!;
				const requests: string[] = [];
				const greeting = "hello\n" + "SIDEKICK_GENERATED_BODY\n".repeat(1500);
				let sidekickContextSize = 0;
				const sessionIds: string[] = [];
				let round = 0;
				runtime.streamSimple = (model, context, options) => {
					requests.push(model.id); sessionIds.push(options?.sessionId ?? "missing");
					const n = ++round;
					expect(n).toBeLessThanOrEqual(5);
					if (n === 3) {
						expect(JSON.stringify(context.messages)).toContain("Use the agreed literal");
						expect(created!.workflow.context().fusionModelRole).toBe("sidekick");
						expect(getCurrentSystemPrompt(context.messages)).toContain("主代理内的 Sidekick 实施");
					}
					if (n === 5) {
						expect(JSON.stringify(context.messages)).toContain("hello.txt");
						expect(JSON.stringify(context.messages)).toContain("Fusion implementation context summary");
						expect(JSON.stringify(context.messages)).not.toContain("SIDEKICK_GENERATED_BODY");
						expect(JSON.stringify(context.messages).length).toBeLessThan(sidekickContextSize);
						expect(getCurrentSystemPrompt(context.messages)).not.toContain("主代理内的 Sidekick 实施");
					}
					if (n === 4) {
						expect(JSON.stringify(context.messages)).toContain("SIDEKICK_GENERATED_BODY");
						sidekickContextSize = JSON.stringify(context.messages).length;
					}
					const write = (id: string, path: string, content: string): ToolCall => ({ type: "toolCall", id, name: "write", arguments: { path, content } });
					const calls: ToolCall[] | undefined = n === 1 ? [write("lead-write", "lead.txt", "forbidden")] :
						n === 2 ? [{ type: "toolCall", id: "implement", name: "fusion_implement", arguments: sameModel ? {
							kind: "worker", description: "Write greeting", prompt: "Use the agreed literal: hello", writablePaths: ["hello.txt"],
							executionPlan: { steps: ["Write hello.txt with hello"], constraints: ["No tests requested"],
								acceptanceCriteria: ["Greeting file exists"], verification: { mode: "skip", checks: [] } },
						} : { instruction: "Use the agreed literal: hello", path: "hello.txt", acceptanceCriterion: "Greeting file exists", skipReason: "No tests requested" }
						}, write("same-batch", "batch.txt", "forbidden")] :
						n === 3 ? [write("outside", "outside.txt", "forbidden"), write("side-write", "hello.txt", greeting)] :
						n === 4 && report ? [{ type: "toolCall", id: "review", name: "fusion_review", arguments: {
							outcome: "completed", summary: "hello.txt implemented", acceptance: [
								{ criterion: "Greeting file exists", status: "unverified", evidence: "No tests requested" }],
						} }, write("after-report", "hello.txt", "forbidden")] : undefined;
					if (n === 4 && handoff === "stop") created!.workflow.stop();
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: {
						...fauxAssistantMessage(n === 4 ? "hello.txt awaits Lead review" : "Reviewed"),
						api: model.api, provider: model.provider, model: model.id, stopReason: calls ? "toolUse" : "stop",
						content: calls ?? [{ type: "text", text: n === 4 ? "hello.txt awaits Lead review" : "Reviewed" }],
					} }));
					return stream;
				};
				created = await createWorkflowSession({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd,
					modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd), initialMode: "agent", getPermission: () => "auto",
					initialFusion: { orchestration: "inline" as const, leadModelKey: `${lead.provider}/${lead.id}`, sidekickModelKey: `${side.provider}/${side.id}`,
						leadThinkingLevel: "off", sidekickThinkingLevel: "off", adaptiveRouting },
					onChange: () => undefined, onModeChange: () => undefined });
				await created.session.prompt("Write a greeting file. Do not test.");
				if (handoff === "stop") {
					expect(round).toBe(4);
					await created.session.prompt("Review the already written greeting. Do not edit or test.");
				}
				expect(requests).toEqual([lead.id, lead.id, side.id, side.id, lead.id]);
				expect(new Set(sessionIds).size).toBe(1);
				expect(await readFile(join(cwd, "hello.txt"), "utf8")).toBe(greeting);
				expect(JSON.stringify(created.session.messages)).toContain("SIDEKICK_GENERATED_BODY");
				for (const path of ["lead.txt", "batch.txt", "outside.txt"]) await expect(readFile(join(cwd, path))).rejects.toThrow();
				expect(created.workflow.state.snapshot().tasks).toHaveLength(0);
				expect(created.session.model?.id).toBe(lead.id);
			} finally {
				created?.workflow.dispose(); created?.session.dispose();
				await created?.workflow.whenSettled(); await rm(cwd, { recursive: true, force: true });
			}
		}, 30000);
	}
});
