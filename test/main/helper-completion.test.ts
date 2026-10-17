import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Api, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRuntime } from "../../src/main/workflow-runtime";
import {
	completeHelper,
	isStreamInterruptionError,
	HELPER_CONTINUATION_PROMPT,
	HELPER_STREAM_RECOVERY_PROMPT,
	MAX_HELPER_CONTINUATIONS,
	MAX_HELPER_STREAM_RECOVERIES,
	boundHelperReport,
} from "../../src/main/helper-completion";

function createMockModel(id = "test-model", maxTokens = 4096): Model<Api> {
	return {
		id,
		provider: "test-provider",
		api: "openai-completions" as Api,
		maxTokens,
	} as Model<Api>;
}

function createAssistantMsg(options: {
	text?: string;
	stopReason?: "stop" | "length" | "error" | "aborted" | "toolUse";
	errorMessage?: string;
	toolCalls?: ToolCall[];
	outputTokens?: number;
	modelId?: string;
}): AssistantMessage {
	const text = options.text ?? "";
	const content: any[] = [];
	if (options.toolCalls) {
		content.push(...options.toolCalls);
	}
	if (text || !options.toolCalls) {
		content.push({ type: "text", text });
	}
	return {
		...fauxAssistantMessage(text),
		api: "openai-completions" as Api,
		provider: "test-provider",
		model: options.modelId ?? "test-model",
		content,
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		usage: {
			input: 10,
			output: options.outputTokens ?? (text ? text.length : 0),
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10 + (options.outputTokens ?? 0),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function createMockSession(options?: {
	model?: Model<Api>;
	initialMessages?: any[];
	onPrompt?: (promptText: string, options?: any) => Promise<AssistantMessage> | AssistantMessage;
}) {
	const messages: any[] = options?.initialMessages ? [...options.initialMessages] : [];
	const originalFinishTurn: NonNullable<AgentSession["agent"]["finishTurn"]> = async () => undefined;
	const promptsReceived: string[] = [];
	const session = {
		model: options?.model,
		messages,
		agent: {
			finishTurn: originalFinishTurn,
		},
		prompt: async (promptText: string, promptOpts?: any) => {
			promptsReceived.push(promptText);
			messages.push({ role: "user", content: [{ type: "text", text: promptText }] });
			if (options?.onPrompt) {
				const response = await options.onPrompt(promptText, promptOpts);
				messages.push(response);
			}
		},
	};
	return { session, originalFinishTurn, promptsReceived, messages };
}

// Real PI session, tool loop and filesystem; only upstream model responses are scripted.
describe("helper recovery integration", () => {
	test("Fast Context removes tools at its budget and returns observed partial locations if the model ignores it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-location-limit-")); let workflow: WorkflowRuntime | undefined;
		try {
			await writeFile(join(cwd, "known.ts"), "export const known = 1;\n");
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only"); const model = getModel("anthropic", "claude-sonnet-4-5")!; let requests = 0;
			runtime.streamSimple = (selected) => {
				requests++; expect(requests).toBeLessThanOrEqual(13);
				const stream = createAssistantMessageEventStream(); queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message: {
					...fauxAssistantMessage(""), api: selected.api, provider: selected.provider, model: selected.id, stopReason: "toolUse",
					content: [{ type: "toolCall", id: `read-${requests}`, name: "read", arguments: { path: "known.ts" } }],
				} })); return stream;
			};
			workflow = new WorkflowRuntime({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd),
				initialMode: "agent", getPermission: () => "auto", onChange: () => undefined, onModeChange: () => undefined });
			workflow.attach({ model, thinkingLevel: "off", messages: [], agent: {}, setActiveToolsByName: () => undefined, subscribe: () => () => undefined } as unknown as AgentSession);
			const helper = workflow as unknown as { runHelper: (role: "subagent", prompt: string, signal: undefined, scopes: string[], step: undefined, options: unknown) => Promise<string> };
			const report = await helper.runHelper("subagent", "Locate known.ts", undefined, [], undefined, { fastContext: true, model, thinkingLevel: "off" });
			expect(requests).toBe(13); expect(report).toContain("Partial code locations only"); expect(report).toContain("OBSERVED read");
			expect(report).toContain("known.ts"); expect(report).toContain("No conclusions or acceptance are verified");
			expect(await readFile(join(cwd, "known.ts"), "utf8")).toBe("export const known = 1;\n");
		} finally { workflow?.dispose(); await workflow?.whenSettled(); await rm(cwd, { recursive: true, force: true }); }
	}, 5000);
	test("provider deadline cancels a hanging SDK request and restores chained hooks", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-provider-deadline-")); let session: AgentSession | undefined;
		try {
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only"); const model = getModel("anthropic", "claude-sonnet-4-5")!; let requests = 0;
			runtime.streamSimple = (selected, _context, options) => {
				requests++; const stream = createAssistantMessageEventStream();
				options!.signal!.addEventListener("abort", () => { stream.push({ type: "error", reason: "aborted", error: {
					...fauxAssistantMessage(""), api: selected.api, provider: selected.provider, model: selected.id, stopReason: "aborted", errorMessage: "Request aborted",
				} }); stream.end(); }, { once: true }); return stream;
			};
			session = (await createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd), model })).session;
			const previousFinish = session.agent.finishTurn; const previousPrepare = session.agent.prepareRequest;
			await expect(completeHelper(session, "Return locations", model, undefined, undefined, { maxTurns: 4, timeoutMs: 10 })).rejects.toThrow("exceeded its time limit");
			expect(requests).toBe(1); expect(session.agent.finishTurn).toBe(previousFinish); expect(session.agent.prepareRequest).toBe(previousPrepare);
		} finally { session?.dispose(); await rm(cwd, { recursive: true, force: true }); }
	}, 5000);
	test("bounded reports retain their ending and explicitly mark missing evidence", () => {
		const report = boundHelperReport("begin" + "x".repeat(10000) + "missing-symbol-end", 6000);
		expect(report.length).toBeLessThanOrEqual(6000); expect(report).toStartWith("begin"); expect(report).toEndWith("missing-symbol-end");
		expect(report).toContain("omitted evidence is unverified");
	});
	test("keeps completed writes and never executes interrupted or truncated tool calls", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "helper-recovery-"));
		let workflow: WorkflowRuntime | undefined;
		try {
			const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
				modelsStorePath: join(cwd, "models-store.json"), allowModelNetwork: false });
			await runtime.setRuntimeApiKey("anthropic", "test-only");
			const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, maxTokens: 256 };
			const sessionIds: string[] = [];
			const recoveries: string[] = [];
			let round = 0;
			runtime.streamSimple = (selected, context, options) => {
				sessionIds.push(options?.sessionId ?? "missing");
				const n = ++round;
				if (n >= 3) {
					expect(JSON.stringify(context.messages)).toContain(JSON.stringify(HELPER_STREAM_RECOVERY_PROMPT));
					expect(JSON.stringify(context.messages)).toContain("kept.txt");
				}
				if (n === 4) expect(JSON.stringify(context.messages)).toContain(JSON.stringify(HELPER_CONTINUATION_PROMPT));
				const stopReason = n === 1 ? "toolUse" : n === 2 ? "error" : n === 3 ? "length" : "stop";
				const call: ToolCall | undefined = n <= 3 ? { type: "toolCall", id: `write-${n}`, name: "write",
					arguments: { path: n === 1 ? "kept.txt" : n === 2 ? "interrupted.txt" : "truncated.txt", content: "saved" } } : undefined;
				const message: AssistantMessage = { ...fauxAssistantMessage("Completed"), api: selected.api,
					provider: selected.provider, model: selected.id, stopReason,
					content: call ? [call] : [{ type: "text", text: "Completed" }],
					errorMessage: n === 2 ? "aborted" : undefined,
					usage: { input: 10, output: n === 3 ? model.maxTokens : 0, cacheRead: 0, cacheWrite: 0,
						totalTokens: n === 3 ? model.maxTokens + 10 : 10,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: stopReason, message });
					stream.end();
				});
				return stream;
			};
			workflow = new WorkflowRuntime({ cwd, agentDir: join(cwd, "agent"), debugRoot: cwd, modelRuntime: runtime,
				sessionManager: SessionManager.inMemory(cwd), initialMode: "agent", getPermission: () => "auto",
				onChange: () => undefined, onModeChange: () => undefined });
			workflow.attach({ model, thinkingLevel: "off", messages: [], agent: {},
				setActiveToolsByName: () => undefined, subscribe: () => () => undefined } as unknown as AgentSession);
			const helper = workflow as unknown as { runHelper: (role: "agent", prompt: string, signal: undefined,
				scopes: string[], onStep: (step: { kind: string; text?: string }) => void) => Promise<string> };
			const result = await helper.runHelper("agent", "Write kept.txt, then finish. Do not run tests.", undefined,
				[cwd], (step) => { if (step.kind === "message" && step.text) recoveries.push(step.text); });
			expect(result).toBe("Completed");
			expect(round).toBe(4);
			expect(new Set(sessionIds).size).toBe(1);
			expect(await readFile(join(cwd, "kept.txt"), "utf8")).toBe("saved");
			await expect(readFile(join(cwd, "interrupted.txt"))).rejects.toThrow();
			await expect(readFile(join(cwd, "truncated.txt"))).rejects.toThrow();
			expect(recoveries.some((text) => text.includes("网络流中断"))).toBe(true);
			expect(recoveries.some((text) => text.includes("输出被截断"))).toBe(true);
		} finally {
			workflow?.dispose();
			await workflow?.whenSettled();
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30000);
});

describe("isStreamInterruptionError", () => {
	test("identifies stream disconnection errors correctly", () => {
		expect(isStreamInterruptionError("aborted")).toBe(true);
		expect(isStreamInterruptionError("The operation was aborted.")).toBe(true);
		expect(isStreamInterruptionError("This operation was aborted")).toBe(true);
		expect(isStreamInterruptionError("request was aborted")).toBe(true);
		expect(isStreamInterruptionError("stream was aborted")).toBe(true);
		expect(isStreamInterruptionError("fetch was aborted")).toBe(true);
		expect(isStreamInterruptionError("BodyStreamBuffer was aborted")).toBe(true);
		expect(isStreamInterruptionError("aborted by peer")).toBe(true);
		expect(isStreamInterruptionError("Premature close")).toBe(true);
		expect(isStreamInterruptionError("prematurely close")).toBe(true);
		expect(isStreamInterruptionError("closed prematurely")).toBe(true);
		expect(isStreamInterruptionError("stream ended without finish_reason")).toBe(true);
		expect(isStreamInterruptionError("stream ended without finish_reason 或完整响应")).toBe(true);
		expect(isStreamInterruptionError("未收到完整响应")).toBe(true);
		expect(isStreamInterruptionError("connection terminated")).toBe(true);
		expect(isStreamInterruptionError("stream terminated")).toBe(true);
		expect(isStreamInterruptionError("terminated prematurely")).toBe(true);
		expect(isStreamInterruptionError("terminated")).toBe(true);
		expect(isStreamInterruptionError("socket hang up")).toBe(true);
	});

	test("rejects non-stream errors (auth, quota, bad request, unknown)", () => {
		expect(isStreamInterruptionError(undefined)).toBe(false);
		expect(isStreamInterruptionError("")).toBe(false);
		expect(isStreamInterruptionError("   ")).toBe(false);
		expect(isStreamInterruptionError("401 Unauthorized: Invalid API key")).toBe(false);
		expect(isStreamInterruptionError("403 Forbidden")).toBe(false);
		expect(isStreamInterruptionError("429 Rate limit exceeded")).toBe(false);
		expect(isStreamInterruptionError("insufficient quota")).toBe(false);
		expect(isStreamInterruptionError("400 Bad request: invalid_request_error")).toBe(false);
		expect(isStreamInterruptionError("Internal Server Error: 500")).toBe(false);
		expect(isStreamInterruptionError("Gateway timeout: 504")).toBe(false);
		// Narrow matching: ordinary messages containing the word 'aborted' must not be matched if they relate to auth/quota/params
		expect(isStreamInterruptionError("Request aborted due to insufficient quota")).toBe(false);
		expect(isStreamInterruptionError("User aborted authentication")).toBe(false);
		expect(isStreamInterruptionError("Transaction aborted: invalid api key")).toBe(false);
		expect(isStreamInterruptionError("Operation aborted because request was invalid_request")).toBe(false);
	});
});

describe("completeHelper recovery behavior", () => {
	test("recovers from stream error (errorMessage='aborted', outputTokens=0) without replaying failed partial tool calls", async () => {
		const model = createMockModel("sidekick-fast");
		const recoveries: string[] = [];
		let step = 0;

		const failedToolCall: ToolCall = {
			type: "toolCall",
			id: "tool-write-1",
			name: "write",
			arguments: { path: "unwritten.txt", content: "partial" },
		};

		const { session, promptsReceived } = createMockSession({
			onPrompt: async () => {
				step++;
				if (step === 1) {
					// Stream error with aborted message and partial toolCall in content
					return createAssistantMsg({
						stopReason: "error",
						errorMessage: "aborted",
						outputTokens: 0,
						toolCalls: [failedToolCall],
					});
				}
				// Recovery response returns final completed text
				return createAssistantMsg({
					text: "Success after recovery",
					stopReason: "stop",
					outputTokens: 15,
				});
			},
		});

		const result = await completeHelper(
			session as unknown as AgentSession,
			"Initial prompt",
			model,
			undefined,
			(msg) => recoveries.push(msg),
		);

		expect(result).toBe("Success after recovery");
		expect(step).toBe(2);
		expect(promptsReceived).toEqual(["Initial prompt", HELPER_STREAM_RECOVERY_PROMPT]);
		expect(recoveries.length).toBe(1);
		expect(recoveries[0]).toContain("sidekick-fast 的网络流中断，正在原任务中恢复（1/2）");
	});

	test("recovers from length truncation and preserves continuation prompts", async () => {
		const model = createMockModel("sidekick-length", 256);
		const recoveries: string[] = [];
		let step = 0;

		const { session, promptsReceived } = createMockSession({
			onPrompt: async () => {
				step++;
				if (step === 1) {
					return createAssistantMsg({
						text: "First half of text...",
						stopReason: "length",
						outputTokens: 256,
					});
				}
				return createAssistantMsg({
					text: "Second half completed",
					stopReason: "stop",
					outputTokens: 100,
				});
			},
		});

		const result = await completeHelper(
			session as unknown as AgentSession,
			"Generate report",
			model,
			undefined,
			(msg) => recoveries.push(msg),
		);

		expect(result).toBe("Second half completed");
		expect(step).toBe(2);
		expect(promptsReceived).toEqual(["Generate report", HELPER_CONTINUATION_PROMPT]);
		expect(recoveries.length).toBe(1);
		expect(recoveries[0]).toContain("sidekick-length 的输出被截断，正在原任务中续写（1/2）");
	});

	test("maintains independent counts for stream recovery and length truncation without resetting each other", async () => {
		const model = createMockModel("hybrid-model");
		const recoveries: string[] = [];
		let step = 0;

		// 1. stream error (streamRecoveries=1)
		// 2. length truncated (continuations=1)
		// 3. stream error (streamRecoveries=2)
		// 4. length truncated (continuations=2)
		// 5. final success
		const { session, promptsReceived } = createMockSession({
			onPrompt: async () => {
				step++;
				if (step === 1) {
					return createAssistantMsg({ stopReason: "error", errorMessage: "Premature close" });
				}
				if (step === 2) {
					return createAssistantMsg({ text: "part 1", stopReason: "length" });
				}
				if (step === 3) {
					return createAssistantMsg({ stopReason: "error", errorMessage: "stream ended without finish_reason" });
				}
				if (step === 4) {
					return createAssistantMsg({ text: "part 2", stopReason: "length" });
				}
				return createAssistantMsg({ text: "Final all good", stopReason: "stop" });
			},
		});

		const result = await completeHelper(
			session as unknown as AgentSession,
			"Complex hybrid task",
			model,
			undefined,
			(msg) => recoveries.push(msg),
		);

		expect(result).toBe("Final all good");
		expect(step).toBe(5);
		expect(promptsReceived).toEqual([
			"Complex hybrid task",
			HELPER_STREAM_RECOVERY_PROMPT,
			HELPER_CONTINUATION_PROMPT,
			HELPER_STREAM_RECOVERY_PROMPT,
			HELPER_CONTINUATION_PROMPT,
		]);
		expect(recoveries).toHaveLength(4);
		expect(recoveries[0]).toContain("网络流中断，正在原任务中恢复（1/2）");
		expect(recoveries[1]).toContain("输出被截断，正在原任务中续写（1/2）");
		expect(recoveries[2]).toContain("网络流中断，正在原任务中恢复（2/2）");
		expect(recoveries[3]).toContain("输出被截断，正在原任务中续写（2/2）");
	});

	test("fails when exceeding MAX_HELPER_STREAM_RECOVERIES (max 3 requests total)", async () => {
		const model = createMockModel("stream-fail-model");
		let step = 0;

		const { session } = createMockSession({
			onPrompt: async () => {
				step++;
				return createAssistantMsg({
					stopReason: "error",
					errorMessage: "The operation was aborted.",
					outputTokens: 0,
				});
			},
		});

		await expect(
			completeHelper(session as unknown as AgentSession, "Will fail", model, undefined),
		).rejects.toThrow("模型请求失败，已尝试流恢复 2 次仍未完成");

		expect(step).toBe(3); // 1 initial request + 2 recoveries = 3 requests
	});

	test("fails when exceeding MAX_HELPER_CONTINUATIONS for length truncation", async () => {
		const model = createMockModel("length-fail-model");
		let step = 0;

		const { session } = createMockSession({
			onPrompt: async () => {
				step++;
				return createAssistantMsg({
					text: `chunk ${step}`,
					stopReason: "length",
					outputTokens: 4096,
				});
			},
		});

		await expect(
			completeHelper(session as unknown as AgentSession, "Will exceed length", model, undefined),
		).rejects.toThrow("输出达到长度限制，已续写 2 次仍未完成");

		expect(step).toBe(3);
	});

	test("bounds recovery when the provider reports aborted without a cancelled caller signal", async () => {
		const model = createMockModel();
		let step = 0;

		const { session } = createMockSession({
			onPrompt: async () => {
				step++;
				return createAssistantMsg({
					stopReason: "aborted",
					errorMessage: "aborted",
				});
			},
		});

		await expect(
			completeHelper(session as unknown as AgentSession, "Explicit abort", model, undefined),
		).rejects.toThrow("模型请求被中断");

		expect(step).toBe(MAX_HELPER_STREAM_RECOVERIES + 1);
	});

	test("does NOT recover on non-stream errors (401, 429, 400, 500)", async () => {
		const model = createMockModel();

		for (const err of [
			"401 Unauthorized",
			"429 Insufficient quota",
			"400 Bad request: invalid parameter",
			"500 Internal server error",
		]) {
			let step = 0;
			const { session } = createMockSession({
				onPrompt: async () => {
					step++;
					return createAssistantMsg({
						stopReason: "error",
						errorMessage: err,
					});
				},
			});

			await expect(
				completeHelper(session as unknown as AgentSession, "Should not retry", model, undefined),
			).rejects.toThrow("模型请求失败");
			expect(step).toBe(1);
		}
	});

	test("aborts immediately when signal is already aborted before first prompt", async () => {
		const model = createMockModel();
		let promptCalled = false;
		const controller = new AbortController();
		controller.abort();

		const { session } = createMockSession({
			onPrompt: async () => {
				promptCalled = true;
				return createAssistantMsg({ text: "ok" });
			},
		});

		await expect(
			completeHelper(session as unknown as AgentSession, "Start", model, controller.signal),
		).rejects.toThrow("子代理已取消");
		expect(promptCalled).toBe(false);
	});

	test("aborts when signal is aborted during/after stream recovery", async () => {
		const model = createMockModel();
		const controller = new AbortController();
		let step = 0;

		const { session } = createMockSession({
			onPrompt: async () => {
				step++;
				if (step === 1) {
					// First prompt fails with stream interruption
					controller.abort(); // Cancel right after/during first prompt
					return createAssistantMsg({ stopReason: "error", errorMessage: "aborted" });
				}
				return createAssistantMsg({ text: "should not be reached" });
			},
		});

		await expect(
			completeHelper(session as unknown as AgentSession, "Start", model, controller.signal),
		).rejects.toThrow("子代理已取消");
		expect(step).toBe(1);
	});

	test("fails when final response text is empty or whitespace only", async () => {
		const model = createMockModel();
		const { session } = createMockSession({
			onPrompt: async () => {
				return createAssistantMsg({ text: "   \n\t  ", stopReason: "stop" });
			},
		});

		await expect(
			completeHelper(session as unknown as AgentSession, "Empty result", model, undefined),
		).rejects.toThrow("未返回有效的最终结果");
	});

	test("preserves prior session messages and tool execution context", async () => {
		const model = createMockModel();
		const initialMessages = [
			{ role: "user", content: [{ type: "text", text: "Create file" }] },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "write", arguments: { path: "a.txt" } }],
			},
			{ role: "tool", toolCallId: "t1", content: [{ type: "text", text: "Success" }] },
		];

		let step = 0;
		const { session, messages } = createMockSession({
			initialMessages,
			onPrompt: async () => {
				step++;
				if (step === 1) {
					return createAssistantMsg({ stopReason: "error", errorMessage: "connection terminated" });
				}
				return createAssistantMsg({ text: "Finished remaining work", stopReason: "stop" });
			},
		});

		const result = await completeHelper(
			session as unknown as AgentSession,
			"Continue work",
			model,
			undefined,
		);

		expect(result).toBe("Finished remaining work");
		// Ensure initial context is not lost
		expect(messages[0].content[0].text).toBe("Create file");
		expect(messages[2].toolCallId).toBe("t1");
	});

	test("uses session.model when available and restores finishTurn hook in all scenarios", async () => {
		const fallbackModel = createMockModel("fallback-model");
		const sessionModel = createMockModel("session-active-model");
		const recoveries: string[] = [];

		const { session, originalFinishTurn } = createMockSession({
			model: sessionModel,
			onPrompt: async () => {
				return createAssistantMsg({ stopReason: "error", errorMessage: "stream ended without finish_reason" });
			},
		});

		await expect(
			completeHelper(
				session as unknown as AgentSession,
				"Check active model",
				fallbackModel,
				undefined,
				(msg) => recoveries.push(msg),
			),
		).rejects.toThrow(/子代理 session-active-model/);

		// Verified that recovery message and failureDetail used session.model
		expect(recoveries[0]).toContain("session-active-model 的网络流中断");

		// Hook restored in finally block
		expect(session.agent.finishTurn).toBe(originalFinishTurn);
	});

	test("finishTurn hook intercepts length stopReason during run", async () => {
		const model = createMockModel();
		let hookDecision: any = null;

		const { session, originalFinishTurn } = createMockSession({
			onPrompt: async () => {
				// While inside prompt, simulate finishTurn invocation
				const currentHook = session.agent.finishTurn;
				hookDecision = await currentHook(
					{ message: { stopReason: "length" } } as any,
					new AbortController().signal,
				);
				return createAssistantMsg({ text: "done" });
			},
		});

		await completeHelper(session as unknown as AgentSession, "Test hook", model, undefined);

		expect(hookDecision).toEqual({ action: "end" });
		expect(session.agent.finishTurn).toBe(originalFinishTurn);
	});
});
