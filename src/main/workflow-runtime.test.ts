import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ModelRuntime, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecutionMode } from "../shared/agent";
import type { WorkMode } from "../shared/workflow";
import {
	createWorkflowSession,
	sampleReasoning,
	savedWorkflow,
	THINKING_SAMPLE_MS,
	type Reasoning,
	type WorkflowRuntime,
	type WorkflowSessionOptions,
} from "./workflow-runtime";
import { COMPACTION_INSTRUCTIONS } from "./prompt-library";
import { waitFor, workflowSandbox } from "./workflow-test-utils";
import { savedFusion } from "./fusion-config";
import { withFusionUsage } from "./fusion-usage";
import { projectMessages } from "./agent-projection";
import type { FusionConfig } from "../shared/fusion";
import { HELPER_CONTINUATION_PROMPT, MAX_HELPER_CONTINUATIONS } from "./helper-completion";

interface RequestBody {
	model: string;
	reasoning_effort?: string;
	messages: Array<{ role: string; content?: unknown }>;
	tools?: Array<{ function: { name: string } }>;
	stream?: boolean;
}
interface Reply {
	finishReason?: "stop" | "length";
	outputTokens?: number;
	reasoning?: string;
	apiError?: string;
	text?: string;
	calls?: Array<{ name: string; args: Record<string, unknown> }>;
	inputTokens?: number;
}
function response(reply: Reply, stream: boolean) {
	if (reply.apiError) return Response.json({ error: { message: reply.apiError, type: "invalid_api_key" } }, { status: 401 });
	const toolCalls = reply.calls?.map((call, index) => ({
		index,
		id: "call_" + index,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.args) },
	}));
	const reason = reply.finishReason ?? (toolCalls?.length ? "tool_calls" : "stop");
	const usage = {
		prompt_tokens: reply.inputTokens ?? 100,
		completion_tokens: reply.outputTokens ?? 50,
		total_tokens: (reply.inputTokens ?? 100) + (reply.outputTokens ?? 50),
	};
	const base = { id: "mock-response", model: "workflow-model", created: 1 };
	if (!stream)
		return Response.json({
			...base,
			object: "chat.completion",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: reply.text ?? null,
						...(toolCalls ? { tool_calls: toolCalls } : {}),
					},
					finish_reason: reason,
				},
			],
			usage,
		});
	const frames = [
		{
			...base,
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						...(reply.text ? { content: reply.text } : {}),
						...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
						...(toolCalls ? { tool_calls: toolCalls } : {}),
					},
					finish_reason: null,
				},
			],
		},
		{
			...base,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: reason }],
		},
		{ ...base, object: "chat.completion.chunk", choices: [], usage },
	];
	return new Response(
		frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	);
}
async function fixture(
	mode: WorkMode,
	handler: (body: RequestBody, index: number) => Reply | Promise<Reply>,
	settings?: object,
	sessionOptions?: Pick<WorkflowSessionOptions, "customTools" | "getPluginTools">,
) {
	const sandbox = workflowSandbox();
	if (settings) writeFileSync(join(sandbox.agentDir, "settings.json"), JSON.stringify(settings));
	const requests: RequestBody[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as RequestBody;
			requests.push(body);
			return response(await handler(body, requests.length - 1), body.stream === true);
		},
	});
	const runtime = await ModelRuntime.create({
		authPath: join(sandbox.agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerProvider("nekocode-workflow-test", {
		name: "Workflow test",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:" + server.port + "/v1",
		apiKey: "test-key",
		authHeader: true,
		models: [
			{
				id: "sidekick-model", name: "Efficient Sidekick", api: "openai-completions",
				reasoning: true, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000, maxTokens: 16000,
				compat: { supportsReasoningEffort: true },
			},
			{
				id: "workflow-model",
				name: "Workflow test",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16000,
			},
		],
	});
	const model = runtime.getModel("nekocode-workflow-test", "workflow-model")!;
	const permission = { value: "auto" as ExecutionMode };
	let onChange: ((flow: WorkflowRuntime) => void) | undefined;
	let current: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
	const manager = SessionManager.create(sandbox.cwd, join(sandbox.root, "sessions"));
	current = await createWorkflowSession({
		cwd: sandbox.cwd,
		agentDir: sandbox.agentDir,
		sessionManager: manager,
		modelRuntime: runtime,
		model,
		initialMode: mode,
		getPermission: () => permission.value,
		debugRoot: join(sandbox.root, "logs"),
		onChange: () => {
			if (current) onChange?.(current.workflow);
		},
		onModeChange: () => {},
		...sessionOptions,
	});
	return {
		...current,
		...sandbox,
		manager,
		requests,
		permission,
		modelRuntime: runtime,
		onChange(callback: (flow: WorkflowRuntime) => void) {
			onChange = callback;
		},
		async cleanup() {
			current!.workflow.dispose();
			await current!.session.abort();
			await current!.workflow.state.whenSettled();
			current!.session.dispose();
			server.stop(true);
			sandbox.cleanup();
		},
	};
}
const toolText = (body: RequestBody) =>
	body.messages
		.filter((message) => message.role === "tool")
		.map((message) => String(message.content))
		.join("\n");

const fusionConfig: FusionConfig = {
	leadModelKey: "nekocode-workflow-test/workflow-model",
	leadThinkingLevel: "high",
	sidekickModelKey: "nekocode-workflow-test/sidekick-model",
	sidekickThinkingLevel: "low",
};

describe("Fusion routing", () => {
	test("Lead's visual specification crosses the task tool and survives Sidekick continuation", async () => {
		const designSpec = "viewBox=0 0 960 640；背景 #F7F1E7；轮轴 (360,460)/(620,460)，半径 80；喙长为头宽的 2.2 倍；踏板与双脚同相位，周期 1.6s；小屏等比缩放，不裁切。";
		let childCalls = 0;
		const f = await fixture("agent", (body, index) => {
			if (body.model === "sidekick-model") {
				// Actual task parameters must reach the isolated child, including on
				// recovery; system instructions alone cannot supply these decisions.
				expect(JSON.stringify(body.messages)).toContain(designSpec);
				expect(JSON.stringify(body.messages)).toContain("不要使用第三方库，不需要测试");
				if (childCalls++ === 0) return { finishReason: "length", outputTokens: 16000, reasoning: "Implementing Lead design" };
				if (childCalls === 2) return { calls: [{ name: "write", args: {
					path: "scene.html", content: '<svg viewBox="0 0 960 640" style="background:#F7F1E7"><circle cx="360" cy="460" r="80"/></svg>',
				} }] };
				return { text: "按规格实现 scene.html；源代码中可核对 viewBox、背景和轮轴。未测试。" };
			}
			if (index === 0) return { calls: [{ name: "task", args: {
				description: "Implement Lead design", kind: "worker", writablePaths: ["scene.html"],
				prompt: "实现骑车场景；不要使用第三方库，不需要测试", designSpec,
			} }] };
			return { text: "Waiting for the implementation report" };
		});
		try {
			await f.workflow.setFusion(fusionConfig);
			await f.session.prompt("制作骑车动画");
			await f.workflow.state.whenSettled();
			expect(f.workflow.state.snapshot().tasks[0].status).toBe("completed");
			expect(readFileSync(join(f.cwd, "scene.html"), "utf8")).toContain('viewBox="0 0 960 640"');
			expect(childCalls).toBe(3);
		} finally { await f.cleanup(); }
	}, 15000);

	test("a reasoning-only length stop continues in the same Sidekick with the original constraints", async () => {
		let childCalls = 0;
		const f = await fixture("agent", (body) => {
			if (body.model !== "sidekick-model") return { text: "Reviewed" };
			if (childCalls++ === 0) return { reasoning: "Planning the long SVG animation", finishReason: "length", outputTokens: 16000 };
			if (childCalls === 2) {
				const context = JSON.stringify(body.messages);
				expect(context).toContain("不要使用第三方库，写完不需要测试");
				expect(context).toContain(HELPER_CONTINUATION_PROMPT.split("\n")[0]);
				return { calls: [{ name: "write", args: { path: "pelican.html", content: "<!doctype html><svg><circle r='20'/></svg>" } }] };
			}
			return { text: "已写入 pelican.html，按要求未测试。" };
		});
		try {
			await f.workflow.setFusion(fusionConfig);
			f.workflow.state.startTask({ description: "Pelican", prompt: "制作鹈鹕骑车 HTML 动画，不要使用第三方库，写完不需要测试", kind: "worker", writablePaths: ["pelican.html"] });
			await f.workflow.state.whenSettled();
			const task = f.workflow.state.snapshot().tasks[0];
			expect(task.status).toBe("completed");
			expect(task.result).toContain("未测试");
			expect(task.steps.some((step) => step.kind === "message" && step.text.includes("续写（1/2）"))).toBe(true);
			expect(readFileSync(join(f.cwd, "pelican.html"), "utf8")).toContain("<svg>");
			expect(childCalls).toBe(3);
		} finally { await f.cleanup(); }
	}, 15000);

	test("length stops with tool calls never write truncated files and recovery stays bounded", async () => {
		let childCalls = 0;
		const f = await fixture("agent", (body) => {
			if (body.model !== "sidekick-model") return { text: "Failure acknowledged" };
			childCalls++;
			return { finishReason: "length", outputTokens: 16000, calls: [{ name: "write", args: { path: "pelican.html", content: "TRUNCATED" } }] };
		});
		try {
			await f.workflow.setFusion(fusionConfig);
			f.workflow.state.startTask({ description: "Long HTML", prompt: "Write the HTML", kind: "worker", writablePaths: ["pelican.html"] });
			await f.workflow.state.whenSettled();
			const task = f.workflow.state.snapshot().tasks[0];
			expect(task.status).toBe("failed");
			expect(task.result).toContain("stopReason=length");
			expect(task.result).toContain("sidekick-model");
			expect(task.result).toContain("16000 tokens");
			expect(childCalls).toBe(MAX_HELPER_CONTINUATIONS + 1);
			expect(existsSync(join(f.cwd, "pelican.html"))).toBe(false);
			expect(savedWorkflow(f.manager)?.tasks[0].result).toContain("stopReason=length");
		} finally { await f.cleanup(); }
	}, 15000);

	test("a truncated final report preserves successful writes when continuing", async () => {
		let childCalls = 0;
		const f = await fixture("agent", (body) => {
			if (body.model !== "sidekick-model") return { text: "Reviewed" };
			if (childCalls++ === 0) return { calls: [{ name: "write", args: { path: "done.html", content: "COMPLETE" } }] };
			if (childCalls === 2) return { text: "Partial final report", finishReason: "length", outputTokens: 16000 };
			expect(toolText(body)).toContain("Successfully wrote");
			return { text: "File already written; no tests requested." };
		});
		try {
			await f.workflow.setFusion(fusionConfig);
			f.workflow.state.startTask({ description: "Write", prompt: "Write without tests", kind: "worker", writablePaths: ["done.html"] });
			await f.workflow.state.whenSettled();
			const task = f.workflow.state.snapshot().tasks[0];
			expect(task.status).toBe("completed");
			expect(task.steps.filter((step) => step.kind === "tool" && step.toolName === "write")).toHaveLength(1);
			expect(readFileSync(join(f.cwd, "done.html"), "utf8")).toBe("COMPLETE");
		} finally { await f.cleanup(); }
	}, 15000);

	test("cancellation at a recovery boundary prevents the continuation request", async () => {
		let childCalls = 0;
		const f = await fixture("agent", (body) => {
			if (body.model !== "sidekick-model") return { text: "Reviewed" };
			childCalls++;
			return { reasoning: "Still thinking", finishReason: "length", outputTokens: 16000 };
		});
		try {
			await f.workflow.setFusion(fusionConfig);
			f.onChange((flow) => {
				if (flow.state.snapshot().tasks.some((task) => task.status === "running" && task.steps.some((step) => step.id === "recovery-1"))) flow.stop();
			});
			f.workflow.state.startTask({ description: "Cancel", prompt: "Investigate", kind: "explore", writablePaths: [] });
			await f.workflow.state.whenSettled();
			expect(f.workflow.state.snapshot().tasks[0].status).toBe("cancelled");
			expect(childCalls).toBe(1);
		} finally { await f.cleanup(); }
	}, 15000);

	test("provider errors retain the model, stop reason and service message without length retries", async () => {
		let childCalls = 0;
		const f = await fixture("agent", (body) => {
			if (body.model !== "sidekick-model") return { text: "Failure acknowledged" };
			childCalls++;
			return { apiError: "Fixture credentials rejected" };
		});
		try {
			await f.workflow.setFusion(fusionConfig);
			f.workflow.state.startTask({ description: "API error", prompt: "Inspect", kind: "explore", writablePaths: [] });
			await f.workflow.state.whenSettled();
			const task = f.workflow.state.snapshot().tasks[0];
			expect(task.status).toBe("failed");
			expect(task.result).toContain("sidekick-model");
			expect(task.result).toContain("stopReason=error");
			expect(task.result).toContain("Fixture credentials rejected");
			expect(childCalls).toBe(1);
		} finally { await f.cleanup(); }
	}, 15000);

	test("Lead delegates to the configured Sidekick and resumes to review", async () => {
		let childCalls = 0;
		const f = await fixture("agent", (body, index) => {
			if (body.model === "sidekick-model") return childCalls++ === 0
				? { calls: [{ name: "write", args: { path: "fusion.txt", content: "implemented" } }] }
				: { text: "IMPLEMENTATION_COMPLETE" };
			if (index === 0) return { calls: [{ name: "task", args: {
				description: "Implement", prompt: "Write fusion.txt as planned",
				kind: "worker", writablePaths: ["fusion.txt"],
			} }] };
			return { text: JSON.stringify(body.messages).includes("IMPLEMENTATION_COMPLETE") ? "LEAD_REVIEWED" : "Waiting" };
		});
		try {
			await f.workflow.setFusion(fusionConfig);
			expect(f.session.thinkingLevel).toBe("off"); // Non-reasoning Lead is clamped.
			await f.session.prompt("PRIVATE_HISTORY: implement the plan");
			await waitFor(() => f.session.messages.some((m) => JSON.stringify(m).includes("LEAD_REVIEWED")));
			expect(readFileSync(join(f.cwd, "fusion.txt"), "utf8")).toBe("implemented");
			const child = f.requests.find((r) => r.model === "sidekick-model")!;
			expect(child.reasoning_effort).toBe("low");
			expect(JSON.stringify(child.messages)).toContain("Fusion · Sidekick");
			expect(JSON.stringify(child.messages)).not.toContain("PRIVATE_HISTORY");
			expect(child.tools?.map((t) => t.function.name)).not.toContain("powershell");
			expect(f.requests[0].model).toBe("workflow-model");
			expect(JSON.stringify(f.requests[0].messages)).toContain("Fusion · Lead");
			expect(savedFusion(f.manager)?.sidekickModelKey).toBe(fusionConfig.sidekickModelKey);
			await f.workflow.state.whenSettled();
			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			const projected = withFusionUsage(projectMessages(reopened.buildSessionContext().messages), reopened.getBranch());
			const last = projected.filter((cell) => cell.type === "assistant").at(-1);
			const usage = last?.type === "assistant" ? last.usage : undefined;
			expect(usage?.fusion?.lead.model).toBe("workflow-model");
			expect(usage?.fusion?.sidekick.usage).toMatchObject({ model: "sidekick-model", calls: 2, input: 200, output: 100, totalTokens: 300 });
			expect(usage?.totalTokens).toBe((usage?.fusion?.lead.totalTokens ?? 0) + 300);
		} finally { await f.cleanup(); }
	}, 15000);

	test("exclusive Sidekick can run a verification command and cannot spawn peers", async () => {
		let childCalls = 0;
		const f = await fixture("agent", (body) => {
			if (body.model !== "sidekick-model") return { text: "Reviewed" };
			return childCalls++ === 0
				? { calls: [{ name: process.platform === "win32" ? "powershell" : "bash", args: {
					command: process.platform === "win32" ? "Write-Output FUSION_VERIFIED" : "echo FUSION_VERIFIED",
				} }] }
				: { text: "VERIFIED: " + toolText(body) };
		});
		try {
			await f.workflow.setFusion(fusionConfig);
			const task = { description: "Verify", prompt: "Run the check", kind: "worker" as const, writablePaths: ["."] };
			f.workflow.state.startTask(task);
			expect(() => f.workflow.state.startTask(task)).toThrow("At most 1");
			await expect(f.workflow.setFusion(null)).rejects.toThrow("停止");
			await f.workflow.state.whenSettled();
			const result = f.workflow.state.snapshot().tasks[0];
			expect(result.status).toBe("completed");
			expect(result.result).toContain("FUSION_VERIFIED");
			const tools = f.requests.find((r) => r.model === "sidekick-model")!.tools!.map((t) => t.function.name);
			expect(tools).not.toContain("task");
			expect(tools).not.toContain("question");
		} finally { await f.cleanup(); }
	}, 15000);

	test("read-only, invalid models and cancellation retain their boundaries", async () => {
		const f = await fixture("agent", async (body) => {
			if (body.model === "sidekick-model") await Bun.sleep(120);
			return { text: "DONE" };
		});
		try {
			await expect(f.workflow.setFusion({ ...fusionConfig, sidekickModelKey: "missing/model" })).rejects.toThrow("Sidekick");
			expect(f.workflow.fusion).toBeNull();
			await f.workflow.setFusion(fusionConfig);
			f.permission.value = "read-only";
			f.workflow.refresh();
			expect(() => f.workflow.state.startTask({ description: "Write", prompt: "Do", kind: "worker", writablePaths: ["."] })).toThrow("read-only");
			f.workflow.state.startTask({ description: "Read", prompt: "Inspect", kind: "explore", writablePaths: [] });
			await waitFor(() => f.requests.length > 0);
			const tools = f.requests[0].tools!.map((t) => t.function.name);
			expect(tools).not.toContain("powershell");
			expect(tools).not.toContain("write");
			f.workflow.stop();
			await f.workflow.state.whenSettled();
			await Bun.sleep(150);
			expect(f.requests).toHaveLength(1);
			expect(f.workflow.state.snapshot().tasks[0].status).toBe("cancelled");
			f.workflow.setMode("plan");
			expect(f.session.getActiveToolNames()).not.toContain("task");
		} finally { await f.cleanup(); }
	}, 15000);

	test("reopening restores both roles and disabling Fusion persists", async () => {
		const f = await fixture("agent", () => ({ text: "OK" }));
		let reopened: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			await f.workflow.setFusion(fusionConfig);
			await f.session.prompt("Persist Fusion");
			reopened = await createWorkflowSession({ cwd: f.cwd, agentDir: f.agentDir,
				sessionManager: SessionManager.open(f.manager.getSessionFile()!), modelRuntime: f.modelRuntime,
				initialMode: "agent", getPermission: () => "auto", debugRoot: join(f.root, "logs"),
				onChange: () => {}, onModeChange: () => {},
			});
			expect(reopened.workflow.fusion).toEqual({ ...fusionConfig, leadThinkingLevel: "off" });
			expect(reopened.session.model?.id).toBe("workflow-model");
			expect(reopened.session.systemPrompt).toContain("Fusion · Lead");
			reopened.workflow.dispose();
			reopened.session.dispose();
			// Removing a provider must not make its old transcript impossible to open.
			f.modelRuntime.unregisterProvider("nekocode-workflow-test");
			reopened = await createWorkflowSession({ cwd: f.cwd, agentDir: f.agentDir,
				sessionManager: SessionManager.open(f.manager.getSessionFile()!), modelRuntime: f.modelRuntime,
				initialMode: "agent", getPermission: () => "auto", debugRoot: join(f.root, "logs"),
				onChange: () => {}, onModeChange: () => {},
			});
			expect(reopened.fusionError).toContain("Lead");
			expect(reopened.workflow.fusion?.sidekickModelKey).toBe(fusionConfig.sidekickModelKey);
			await reopened.workflow.setFusion(null);
			expect(savedFusion(reopened.session.sessionManager)).toBeNull();
			expect(reopened.session.systemPrompt).not.toContain("Fusion · Lead");
		} finally { reopened?.workflow.dispose(); reopened?.session.dispose(); await f.cleanup(); }
	}, 15000);
});

describe("PI workflow end-to-end (loopback model)", () => {
	test("sends NekoCode prompts and only read tools in Ask mode", async () => {
		const f = await fixture("ask", () => ({ text: "ANSWER" }));
		try {
			await f.session.prompt("Explain the project");
			expect(JSON.stringify(f.requests[0].messages)).toContain(
				"nekocode-workflow-test/workflow-model",
			);
			expect(JSON.stringify(f.requests[0].messages)).toContain("Ask 工作模式");
			expect(f.requests[0].tools?.map((tool) => tool.function.name)).toEqual([
				"read",
				"grep",
				"find",
				"ls",
				"stat",
				"question",
				"switch_mode",
			]);
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("execution guard blocks writes even if the tool list was changed outside the workflow", async () => {
		const f = await fixture("ask", (_, index) =>
			index === 0
				? { calls: [{ name: "write", args: { path: "forbidden.txt", content: "bad" } }] }
				: { text: "Blocked" },
		);
		try {
			f.session.setActiveToolsByName(["write"]);
			await f.session.prompt("Try writing");
			expect(existsSync(join(f.cwd, "forbidden.txt"))).toBe(false);
			expect(toolText(f.requests[1])).toContain("not allowed");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("question waits for a real answer and sends the answer as a native tool result", async () => {
		const f = await fixture("plan", (_, index) =>
			index === 0
				? {
						calls: [
							{
								name: "question",
								args: {
									title: "Choose",
									questions: [
										{ id: "q", question: "Which?", options: [{ id: "one", label: "Option one" }] },
									],
								},
							},
						],
					}
				: { text: "PLAN" },
		);
		try {
			const pending = f.session.prompt("Plan the change");
			await waitFor(() => f.workflow.state.hasPendingQuestion);
			expect(f.requests).toHaveLength(1);
			f.workflow.answer({
				requestId: f.workflow.state.snapshot().request!.id,
				answers: { q: { optionId: "one", text: "Keep compatibility" } },
			});
			await pending;
			expect(toolText(f.requests[1])).toContain("Keep compatibility");
			expect(f.workflow.state.hasPendingQuestion).toBe(false);
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("approved mode changes take effect within the same tool batch and persist", async () => {
		const f = await fixture("multitask", (_, index) =>
			index === 0
				? {
						calls: [
							{ name: "switch_mode", args: { mode: "plan", reason: "Review the plan first" } },
							{ name: "write", args: { path: "blocked-after-switch.txt", content: "bad" } },
						],
					}
				: { text: "PLAN" },
		);
		try {
			const pending = f.session.prompt("Switch to planning");
			await waitFor(() => f.workflow.state.hasPendingQuestion);
			expect(f.workflow.workMode).toBe("multitask");
			f.workflow.answer({
				requestId: f.workflow.state.snapshot().request!.id,
				answers: { mode: { optionId: "approve" } },
			});
			await pending;
			expect(f.workflow.workMode).toBe("plan");
			expect(existsSync(join(f.cwd, "blocked-after-switch.txt"))).toBe(false);
			expect(savedWorkflow(f.manager)?.workMode).toBe("plan");
			expect(toolText(f.requests[1])).toContain("not allowed");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("automatic routing traverses phases and implements without mode approval; tool guidance follows the phase", async () => {
		const modes = ["ask", "plan", "debug", "multitask", "agent"];
		const f = await fixture("agent", (_, index) => {
			if (index < modes.length) return { calls: [{ name: "switch_mode", args: { mode: modes[index], reason: "Next task phase" } }] };
			if (index === modes.length) return { calls: [{ name: "write", args: { path: "automatic.txt", content: "Implemented" } }] };
			return { text: "DELIVERED" };
		});
		try {
			await f.session.prompt("Implement the feature, choosing the necessary phases yourself");
			expect(f.workflow.workMode).toBe("agent");
			expect(f.workflow.agentPhase).toBe("execute");
			expect(f.workflow.state.hasPendingQuestion).toBe(false);
			expect(readFileSync(join(f.cwd, "automatic.txt"), "utf8")).toBe("Implemented");
			const phases = ["execute", "answer", "plan", "debug", "delegate", "execute"];
			for (const [index, phase] of phases.entries()) {
				const request = f.requests[index];
				const system = String(request.messages.find((m) => m.role === "system")?.content);
				expect(system).toContain("### 当前阶段：" + phase);
				expect(system).toContain("Agent 全自动工作模式");
				const canEdit = request.tools?.some((tool) => tool.function.name === "edit") ?? false;
				// This guideline comes from the actual edit definition through PI's
				// custom prompt branch, not a duplicate in our mode prompt.
				expect(system.includes("Keep edits[].oldText as small as possible")).toBe(canEdit);
			}
			expect(f.requests).toHaveLength(7);
		} finally { await f.cleanup(); }
	}, 15000);

	test("the automatic mode changes phase with no confirmation card and stays in Agent", async () => {
		const f = await fixture("agent", (_, index) =>
			index === 0
				? {
						calls: [
							{ name: "switch_mode", args: { mode: "plan", reason: "Scope this first" } },
							{ name: "write", args: { path: "blocked-after-phase.txt", content: "bad" } },
						],
					}
				: { text: "PLAN" },
		);
		try {
			await f.session.prompt("Work out how to do this");
			// No question was ever raised: the user picked automatic, so the model
			// picks the phase itself.
			expect(f.workflow.state.hasPendingQuestion).toBe(false);
			expect(f.workflow.workMode).toBe("agent");
			expect(f.workflow.agentPhase).toBe("plan");
			// And the phase's read-only discipline is enforced, not merely stated:
			// the write in the same batch is refused after the phase took effect.
			expect(existsSync(join(f.cwd, "blocked-after-phase.txt"))).toBe(false);
			expect(toolText(f.requests[1])).toContain("not allowed");
			expect(f.session.getActiveToolNames()).not.toContain("write");
			expect(savedWorkflow(f.manager)?.phase).toBe("plan");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("the automatic mode reaches background delegation without leaving Agent", async () => {
		let parentCalls = 0;
		let delegateTools: string[] = [];
		const f = await fixture("agent", (body) => {
			if (JSON.stringify(body.messages).includes("这是后台子会话")) return { text: "SCOUT REPORT" };
			// The phase widens the tool set, so delegation is the step after the
			// switch — the model only sees `task` once the list has refreshed.
			const step = parentCalls++;
			if (step === 0)
				return {
					calls: [
						{ name: "switch_mode", args: { mode: "multitask", reason: "Independent probes" } },
					],
				};
			if (step > 1) return { text: "DONE" };
			delegateTools = body.tools?.map((tool) => tool.function.name) ?? [];
			return {
				calls: [
					{
						name: "task",
						args: {
							description: "Scout",
							prompt: "Inspect the layout",
							kind: "explore",
							writablePaths: [],
						},
					},
				],
			};
		});
		try {
			await f.session.prompt("Look into two independent areas");
			expect(f.workflow.workMode).toBe("agent");
			expect(f.workflow.agentPhase).toBe("delegate");
			expect(delegateTools).toContain("task");
			await waitFor(() => f.workflow.state.snapshot().tasks[0]?.status === "completed");
			expect(f.workflow.state.snapshot().tasks[0].result).toContain("SCOUT REPORT");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("a phase that unlocks tools only widens the set on the next model step", async () => {
		const f = await fixture("agent", (_, index) =>
			index === 0
				? {
						calls: [
							{ name: "switch_mode", args: { mode: "multitask", reason: "Delegate" } },
							{
								name: "task",
								args: { description: "Too early", prompt: "x", kind: "explore", writablePaths: [] },
							},
						],
					}
				: { text: "DONE" },
		);
		try {
			await f.session.prompt("Delegate immediately");
			// PI fixes the dispatchable tools when the turn starts, so the model is
			// told plainly rather than left to guess why the call vanished.
			expect(toolText(f.requests[1])).toContain("下一步");
			expect(f.workflow.state.snapshot().tasks).toHaveLength(0);
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("the automatic mode cannot delegate from a phase without the task tool", async () => {
		const f = await fixture("agent", () => ({ text: "OK" }));
		try {
			expect(f.workflow.agentPhase).toBe("execute");
			expect(() =>
				f.workflow.state.startTask({
					description: "Sneak",
					prompt: "Inspect",
					kind: "explore",
					writablePaths: [],
				}),
			).toThrow("delegate phase");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("rejecting a mode switch leaves both mode and tools unchanged", async () => {
		const f = await fixture("ask", (_, index) =>
			index === 0
				? { calls: [{ name: "switch_mode", args: { mode: "agent", reason: "Implement now" } }] }
				: { text: "Still read-only" },
		);
		try {
			const pending = f.session.prompt("Discuss a change");
			await waitFor(() => f.workflow.state.hasPendingQuestion);
			f.workflow.answer({
				requestId: f.workflow.state.snapshot().request!.id,
				answers: { mode: { optionId: "reject" } },
			});
			await pending;
			expect(f.workflow.workMode).toBe("ask");
			expect(f.session.getActiveToolNames()).not.toContain("write");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("write workers edit declared paths and automatically resume the parent", async () => {
		let childRequests = 0;
		const f = await fixture("multitask", (body, index) => {
			const allText = JSON.stringify(body.messages);
			if (allText.includes("这是后台子会话"))
				return childRequests++ === 0
					? { calls: [{ name: "write", args: { path: "worker.txt", content: "FROM_WORKER" } }] }
					: { text: "WORKER_DONE" };
			if (allText.includes("后台任务状态更新")) return { text: "PARENT_RESUMED" };
			return index === 0
				? {
						calls: [
							{
								name: "task",
								args: {
									description: "Write one file",
									prompt: "Write the file",
									kind: "worker",
									writablePaths: ["worker.txt"],
								},
							},
						],
					}
				: { text: "Worker is running" };
		});
		try {
			await f.session.prompt("Delegate a change");
			await waitFor(() =>
				f.session.messages.some(
					(message) =>
						message.role === "assistant" &&
						JSON.stringify(message.content).includes("PARENT_RESUMED"),
				),
			);
			expect(readFileSync(join(f.cwd, "worker.txt"), "utf8")).toBe("FROM_WORKER");
			expect(f.workflow.state.snapshot().tasks[0].status).toBe("completed");
			const child = f.requests.find((body) =>
				JSON.stringify(body.messages).includes("这是后台子会话"),
			)!;
			expect(child.tools?.map((tool) => tool.function.name)).not.toContain("bash");
			expect(child.tools?.map((tool) => tool.function.name)).not.toContain("task");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("a worker's tool calls reach the parent, and stay out of the session file", async () => {
		let childCalls = 0;
		const f = await fixture("multitask", (body) => {
			if (JSON.stringify(body.messages).includes("这是后台子会话"))
				return childCalls++ === 0
					? { calls: [{ name: "read", args: { path: "probe.txt" } }] }
					: { text: "WORKER REPORT" };
			return { text: "OK" };
		});
		try {
			writeFileSync(join(f.cwd, "probe.txt"), "hello");
			f.workflow.state.startTask({
				description: "Scout",
				prompt: "Inspect",
				kind: "explore",
				writablePaths: [],
			});
			await waitFor(() => f.workflow.state.snapshot().tasks[0]?.status === "completed");
			const [task] = f.workflow.state.snapshot().tasks;
			// The child runs on its own in-memory session, so without forwarding
			// these the parent could only report the worker after it finished.
			const tools = task.steps.filter((step) => step.kind === "tool");
			expect(tools.map((step) => step.toolName)).toEqual(["read"]);
			expect(tools[0].status).toBe("done");
			expect(tools[0].args).toContain("probe.txt");
			expect(tools[0].output).toContain("hello");
			expect(tools[0].endedAt).toBeGreaterThanOrEqual(tools[0].startedAt);
			// And what it said on the way, which is what makes the calls read as work.
			expect(
				task.steps.some((step) => step.kind === "message" && step.text.includes("WORKER REPORT")),
			).toBe(true);
			expect(task.result).toContain("WORKER REPORT");
			// Steps are live state, not history: the file keeps the report.
			const saved = savedWorkflow(f.manager)!;
			expect(saved.tasks[0].result).toContain("WORKER REPORT");
			expect(JSON.stringify(saved.tasks)).not.toContain("probe.txt");
			expect(JSON.stringify(saved.tasks)).not.toContain("steps");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("worker reasoning is sampled, not forwarded per token", () => {
		const entry: Reasoning = {
			id: "thinking-1",
			startedAt: 1000,
			text: "weighing",
			flushedAt: 0,
			closed: false,
		};
		const sample = (at: number) => {
			const step = sampleReasoning(entry, at);
			if (step === null) return null;
			if (step.kind !== "thinking") throw new Error("Expected a reasoning step");
			return step;
		};

		// First look always reports; the rest of that interval stays quiet, or a
		// worker would push a fresh snapshot across the bridge on every token.
		expect(sample(10_000)?.text).toBe("weighing");
		entry.text = "weighing more";
		expect(sample(10_000 + THINKING_SAMPLE_MS - 1)).toBeNull();
		expect(sample(10_000 + THINKING_SAMPLE_MS)?.text).toBe("weighing more");

		// Closing reports once regardless of the interval, so the text the panel
		// settles on is all of it rather than the last sample that happened to fit.
		entry.text = "settled";
		entry.endedAt = 12_000;
		const closing = sample(10_000 + THINKING_SAMPLE_MS);
		expect(closing?.text).toBe("settled");
		expect(closing?.endedAt).toBe(12_000);
		expect(sample(99_999)).toBeNull();
	});
	test("a read-only worker can measure files instead of probing read offsets", async () => {
		let childCalls = 0;
		let childTools: string[] = [];
		const f = await fixture("multitask", (body) => {
			if (!JSON.stringify(body.messages).includes("这是后台子会话")) return { text: "OK" };
			if (childCalls++ > 0) return { text: "MEASURED" };
			childTools = body.tools?.map((tool) => tool.function.name) ?? [];
			return { calls: [{ name: "stat", args: { paths: ["probe.txt", "other.txt"] } }] };
		});
		try {
			writeFileSync(join(f.cwd, "probe.txt"), "a\nb\nc\n");
			writeFileSync(join(f.cwd, "other.txt"), "x\n");
			f.workflow.state.startTask({
				description: "Measure",
				prompt: "How big are these",
				kind: "explore",
				writablePaths: [],
			});
			await waitFor(() => f.workflow.state.snapshot().tasks[0]?.status === "completed");

			// The tool reaches the worker, which is the whole reason it is not a
			// workflow tool: those are stripped from anything unattended.
			expect(childTools).toContain("stat");
			expect(childTools).not.toContain("bash");
			const [step] = f.workflow.state
				.snapshot()
				.tasks[0].steps.filter((entry) => entry.kind === "tool");
			expect(step.toolName).toBe("stat");
			expect(step.output).toContain('"lines":3');
			expect(step.output).toContain('"lines":1');
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("a worker stopped mid-tool leaves no step still spinning", async () => {
		const f = await fixture("multitask", async (body) => {
			if (JSON.stringify(body.messages).includes("这是后台子会话")) {
				await Bun.sleep(150);
				return { text: "LATE" };
			}
			return { text: "OK" };
		});
		try {
			const task = f.workflow.state.startTask({
				description: "Slow scout",
				prompt: "Inspect",
				kind: "explore",
				writablePaths: [],
			});
			await waitFor(() => f.requests.length > 0);
			f.workflow.cancelTask(task.id);
			await f.workflow.state.whenSettled();
			const [settled] = f.workflow.state.snapshot().tasks;
			expect(settled.status).toBe("cancelled");
			expect(settled.steps.every((step) => step.kind !== "tool" || step.status !== "running")).toBe(
				true,
			);
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("write workers cannot modify undeclared paths", async () => {
		let childRequests = 0;
		const f = await fixture("multitask", (body) =>
			JSON.stringify(body.messages).includes("这是后台子会话") && childRequests++ === 0
				? { calls: [{ name: "write", args: { path: "other.txt", content: "bad" } }] }
				: { text: "DONE" },
		);
		try {
			f.workflow.state.startTask({
				description: "Scoped",
				prompt: "Write",
				kind: "worker",
				writablePaths: ["allowed.txt"],
			});
			await f.workflow.state.whenSettled();
			expect(existsSync(join(f.cwd, "other.txt"))).toBe(false);
			expect(f.requests.some((request) => toolText(request).includes("declared scope"))).toBe(true);
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("debug log status/read/clear affects only the current session's log", async () => {
		const f = await fixture("debug", () => ({ text: "OK" }));
		try {
			const status = (await f.workflow.debugLog("status")) as { path: string; httpServer: boolean };
			expect(status.httpServer).toBe(false);
			writeFileSync(status.path, '{"hypothesis":"A"}\n');
			const read = (await f.workflow.debugLog("read")) as { content: string };
			expect(read.content).toContain('"hypothesis":"A"');
			await f.workflow.debugLog("clear");
			expect(readFileSync(status.path, "utf8")).toBe("");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("commit helper uses the staged diff and never creates a commit", async () => {
		const f = await fixture("agent", () => ({ text: "feat: add fixture" }));
		try {
			execFileSync("git", ["init"], { cwd: f.cwd, windowsHide: true, stdio: "pipe" });
			writeFileSync(join(f.cwd, "change.txt"), "fixture change");
			execFileSync("git", ["add", "--", "change.txt"], { cwd: f.cwd, windowsHide: true });
			expect(await f.workflow.commitMessage("Use English")).toBe("feat: add fixture");
			expect(f.requests[0].tools ?? []).toEqual([]);
			expect(JSON.stringify(f.requests[0].messages)).toContain("fixture change");
			expect(() =>
				execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
					cwd: f.cwd,
					windowsHide: true,
					stdio: "pipe",
				}),
			).toThrow();
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("the app's compaction instructions reach PI's manual summary request", async () => {
		const f = await fixture(
			"agent",
			(body) =>
				JSON.stringify(body.messages).includes("context summarization assistant")
					? { text: "## Goal\nPreserve the task\n## Progress\nDone\n## Next Steps\nContinue" }
					: { text: "Investigated " + "details ".repeat(1000) },
			{ compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 100 } },
		);
		try {
			await f.session.prompt("Investigate " + "source ".repeat(1000));
			await f.session.prompt("Continue " + "analysis ".repeat(1000));
			await f.session.compact("Also preserve the user decision");
			const summary = f.requests.find((body) =>
				JSON.stringify(body.messages).includes("context summarization assistant"),
			);
			expect(summary).toBeDefined();
			expect(JSON.stringify(summary!.messages)).toContain(COMPACTION_INSTRUCTIONS.split("\n")[0]);
			expect(JSON.stringify(summary!.messages)).toContain("Also preserve the user decision");
		} finally {
			await f.cleanup();
		}
	}, 15000);

	test("approved work-mode changes never elevate read-only permission", async () => {
		const f = await fixture("ask", (_, index) =>
			index === 0
				? { calls: [{ name: "switch_mode", args: { mode: "agent", reason: "Proceed" } }] }
				: { text: "Permission retained" },
		);
		try {
			f.permission.value = "read-only";
			f.workflow.refresh();
			const pending = f.session.prompt("Switch mode");
			await waitFor(() => f.workflow.state.hasPendingQuestion);
			f.workflow.answer({
				requestId: f.workflow.state.snapshot().request!.id,
				answers: { mode: { optionId: "approve" } },
			});
			await pending;
			expect(f.workflow.workMode).toBe("agent");
			expect(f.session.getActiveToolNames()).not.toContain("write");
			expect(f.session.getActiveToolNames()).not.toContain("powershell");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("stopping a question releases the native tool call without a fabricated answer", async () => {
		const f = await fixture("plan", () => ({
			calls: [
				{
					name: "question",
					args: {
						title: "Need input",
						questions: [{ id: "q", question: "What next?", options: [] }],
					},
				},
			],
		}));
		try {
			const pending = f.session.prompt("Plan");
			await waitFor(() => f.workflow.state.hasPendingQuestion);
			f.workflow.stop();
			await f.session.abort();
			await pending;
			expect(f.workflow.state.hasPendingQuestion).toBe(false);
			expect(f.requests).toHaveLength(1);
			expect(f.session.isStreaming).toBe(false);
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("stopping workers prevents late completions from restarting the parent", async () => {
		const f = await fixture("multitask", async (body) => {
			if (JSON.stringify(body.messages).includes("这是后台子会话")) await Bun.sleep(100);
			return { text: "LATE_RESULT" };
		});
		try {
			f.workflow.state.startTask({
				description: "Slow explore",
				prompt: "Inspect",
				kind: "explore",
				writablePaths: [],
			});
			await waitFor(() => f.requests.length > 0);
			f.workflow.stop();
			await f.session.abort();
			await f.workflow.state.whenSettled();
			await Bun.sleep(120);
			expect(f.workflow.state.snapshot().tasks[0].status).toBe("cancelled");
			expect(f.requests).toHaveLength(1);
			expect(f.session.messages.some((message) => message.role === "custom")).toBe(false);
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("reopening a session restores its work mode and todo state", async () => {
		const f = await fixture("agent", () => ({ text: "OK" }));
		let reopened: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			await f.session.prompt("Persist this session");
			f.workflow.setMode("plan");
			f.workflow.state.writeTodos([{ id: "plan", text: "Review the proposal", status: "pending" }]);
			reopened = await createWorkflowSession({
				cwd: f.cwd,
				agentDir: f.agentDir,
				sessionManager: SessionManager.open(f.manager.getSessionFile()!),
				modelRuntime: f.modelRuntime,
				initialMode: "agent",
				getPermission: () => "auto",
				debugRoot: join(f.root, "logs"),
				onChange: () => {},
				onModeChange: () => {},
			});
			expect(reopened.workflow.workMode).toBe("plan");
			expect(reopened.workflow.state.snapshot().todos[0].id).toBe("plan");
			expect(reopened.session.getActiveToolNames()).not.toContain("write");
			expect(reopened.session.systemPrompt).toContain("Review the proposal");
		} finally {
			reopened?.workflow.dispose();
			reopened?.session.dispose();
			await f.cleanup();
		}
	}, 15000);
	test("reopening a session restores the phase the automatic mode was in", async () => {
		const f = await fixture("agent", () => ({ text: "OK" }));
		let reopened: Awaited<ReturnType<typeof createWorkflowSession>> | undefined;
		try {
			await f.session.prompt("Persist this session");
			f.workflow.setPhase("debug");
			reopened = await createWorkflowSession({
				cwd: f.cwd,
				agentDir: f.agentDir,
				sessionManager: SessionManager.open(f.manager.getSessionFile()!),
				modelRuntime: f.modelRuntime,
				initialMode: "agent",
				getPermission: () => "auto",
				debugRoot: join(f.root, "logs"),
				onChange: () => {},
				onModeChange: () => {},
			});
			expect(reopened.workflow.agentPhase).toBe("debug");
			expect(reopened.session.getActiveToolNames()).toContain("debug_log");
			expect(reopened.session.systemPrompt).toContain("当前阶段：debug");
		} finally {
			reopened?.workflow.dispose();
			reopened?.session.dispose();
			await f.cleanup();
		}
	}, 15000);
	test("picking the automatic mode again starts it from the default phase", async () => {
		const f = await fixture("agent", () => ({ text: "OK" }));
		try {
			f.workflow.setPhase("answer");
			f.workflow.setMode("plan");
			f.workflow.setMode("agent");
			// The phase a previous run ended on says nothing about the next request.
			expect(f.workflow.agentPhase).toBe("execute");
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("the app's compaction instructions also reach automatic threshold summaries", async () => {
		const f = await fixture(
			"agent",
			(body) =>
				JSON.stringify(body.messages).includes("context summarization assistant")
					? { text: "## Goal\nContinue\n## Progress\nInvestigated\n## Next Steps\nVerify" }
					: { text: "Evidence " + "detail ".repeat(1000), inputTokens: 127100 },
			{ compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 } },
		);
		try {
			await f.session.prompt("Inspect " + "source ".repeat(1000));
			await waitFor(() =>
				f.requests.some((body) =>
					JSON.stringify(body.messages).includes("context summarization assistant"),
				),
			);
			const summary = f.requests.find((body) =>
				JSON.stringify(body.messages).includes("context summarization assistant"),
			)!;
			expect(JSON.stringify(summary.messages)).toContain(COMPACTION_INSTRUCTIONS.split("\n")[0]);
			expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		} finally {
			await f.cleanup();
		}
	}, 15000);

	test("late worker cleanup cannot recreate a deleted session file", async () => {
		const f = await fixture("multitask", async (body) => {
			if (JSON.stringify(body.messages).includes("这是后台子会话")) await Bun.sleep(100);
			return { text: "OK" };
		});
		try {
			await f.session.prompt("Open the session");
			f.workflow.state.startTask({
				description: "Inspect",
				prompt: "Read",
				kind: "explore",
				writablePaths: [],
			});
			await waitFor(() => f.requests.length > 1);
			f.workflow.dispose();
			f.session.dispose();
			const file = f.manager.getSessionFile()!;
			unlinkSync(file);
			await f.workflow.state.whenSettled();
			await Bun.sleep(120);
			expect(existsSync(file)).toBe(false);
		} finally {
			await f.cleanup();
		}
	}, 15000);
	test("concurrent worker completions all reach the parent", async () => {
		const f = await fixture("multitask", () => ({ text: "RESULT" }));
		try {
			const tasks = Array.from({ length: 4 }, (_, index) =>
				f.workflow.state.startTask({
					description: "Inspect " + index,
					prompt: "Inspect",
					kind: "explore",
					writablePaths: [],
				}),
			);
			await f.workflow.state.whenSettled();
			await waitFor(() =>
				tasks.every((task) =>
					f.session.messages.some(
						(message) =>
							message.role === "custom" && JSON.stringify(message.content).includes(task.id),
					),
				),
			);
			expect(f.workflow.state.snapshot().tasks.every((task) => task.status === "completed")).toBe(
				true,
			);
		} finally {
			await f.cleanup();
		}
	}, 15000);

	test("a native custom tool registers and rides the acting-phase gate like a plugin tool", async () => {
		const navigate: ToolDefinition = {
			name: "browser_navigate",
			label: "Browser navigate",
			description: "Test double",
			parameters: Type.Object({ url: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "navigated" }], details: {} };
			},
		};
		const f = await fixture("agent", () => ({ text: "OK" }), undefined, {
			customTools: [navigate],
			getPluginTools: () => ["browser_navigate"],
		});
		try {
			expect(f.session.getActiveToolNames()).toContain("browser_navigate");
			f.workflow.setMode("plan");
			expect(f.session.getActiveToolNames()).not.toContain("browser_navigate");
		} finally {
			await f.cleanup();
		}
	}, 15000);
});
