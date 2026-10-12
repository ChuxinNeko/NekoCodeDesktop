import { describe, expect, test, spyOn } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { selectFastContextModel, WorkflowRuntime } from "../../src/main/workflow-runtime";
import { FusionRoutingState } from "../../src/main/fusion-routing";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { resolveFusion } from "../../src/main/fusion-config";
import type { TaskInput, TaskStep, TaskRunResult } from "../../src/shared/workflow";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const model = (provider: string, id: string) => ({ provider, id }) as Model<Api>;
const parent = model("anthropic", "lead");
const sidekick = model("zai", "side");
const fusion = {
	config: {
		leadModelKey: "anthropic/lead", leadThinkingLevel: "high",
		sidekickModelKey: "zai/side", sidekickThinkingLevel: "medium",
	},
	lead: parent, sidekick,
} as Awaited<ReturnType<typeof resolveFusion>>;

describe("Fusion task runtime gate", () => {
	const setup = (enabled: boolean, permission: "auto" | "read-only" = "auto") => {
		const options = {
			cwd: process.cwd(), initialFusion: enabled ? fusion.config : null,
			initialMode: enabled ? "agent" : "multitask", getPermission: () => permission, debugRoot: process.cwd(),
			sessionManager: { getBranch: () => [], appendCustomEntry: () => undefined },
			modelRuntime: {}, onChange: () => undefined, onModeChange: () => undefined,
		} as unknown as ConstructorParameters<typeof WorkflowRuntime>[0];
		const runtime = new WorkflowRuntime(options);
		const session = {
			agent: {}, model: parent, setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
		} as unknown as AgentSession;
		runtime.attach(session);
		const gate = (args: unknown, name = "task") => session.agent.beforeToolCall!({
			toolCall: { name, id: "task-call", arguments: args }, args,
		} as Parameters<NonNullable<typeof session.agent.beforeToolCall>>[0]);
		return { runtime, gate };
	};
	test("Fast Context wraps a forwarded problem as a location-only request", async () => {
		const { runtime } = setup(false);
		const query = "登录后白屏，分析根因并给出修复方案";
		let captured = "";
		const harness = runtime as unknown as {
			runHelper: (role: string, prompt: string, signal: unknown, paths: string[], onStep: unknown,
				options: { fastContext?: boolean }) => Promise<string>;
		};
		harness.runHelper = async (role, prompt, _signal, paths, _onStep, options) => {
			expect(role).toBe("subagent");
			expect(paths).toEqual([]);
			expect(options.fastContext).toBe(true);
			captured = prompt;
			return "- src/login.ts:1-20 — login entry";
		};
		expect(await runtime.searchCode(query)).toContain("src/login.ts:1-20");
		expect(captured).toContain("Location target:\n" + query);
		expect(captured).toContain("only locate the relevant code");
		expect(captured).toContain("do not provide root-cause conclusions");
		expect(captured).toContain("The parent agent owns analysis and decisions");
		expect(captured).not.toContain("answer this request");
	});

	test("worker handoff returns observed evidence even when the helper fails", async () => {
		for (const fails of [false, true]) {
			const { runtime } = setup(true);
			// Stub only the external model run; exercise actual task prompt/result wiring.
			const harness = runtime as unknown as {
				runHelper: (role: string, prompt: string, signal: AbortSignal, paths: string[], onStep: (step: TaskStep) => void) => Promise<string>;
				runTask: (input: TaskInput, signal: AbortSignal, onStep: (step: TaskStep) => void) => Promise<TaskRunResult>;
			};
			harness.runHelper = async (_role, prompt, _signal, _paths, onStep) => {
				expect(prompt).toContain("Lead 执行计划");
				expect(prompt).toContain("bun test regression.test.ts");
				onStep({ kind: "tool", id: "check", toolName: "bash", args: "bun test regression.test.ts",
					status: "error", output: "Regression failed", startedAt: 1, endedAt: 2 });
				if (fails) throw new Error("Model unavailable");
				return "Needs Lead review";
			};
			const input: TaskInput = { kind: "worker", description: "Fix", prompt: "Implement", writablePaths: ["."],
				executionPlan: { steps: ["Fix regression"], constraints: [], acceptanceCriteria: ["Regression passes"],
					verification: { mode: "run", checks: ["bun test regression.test.ts"] } } };
			const steps: TaskStep[] = [];
			const result = harness.runTask(input, new AbortController().signal, (step) => steps.push(step));
			if (fails) {
				await expect(result).rejects.toThrow("Regression failed");
			} else {
				const handoff = await result;
				expect(handoff.text).toContain("Regression failed");
				expect(handoff.outcome).toBe("needs_decision");
			}
			expect(steps).toHaveLength(1);
		}
	});
	test("Fusion Lead must delegate code location and edits to Sidekick", async () => {
		const { gate } = setup(true);
		for (const name of ["write", "edit", "ast_edit", "bash", "powershell"])
			expect((await gate({ path: "fusion-should-not-exist.txt" }, name))?.block, name).toBe(true);
		for (const name of ["grep", "find", "ls", "stat", "ast_grep", "semantic_search"]) {
			expect((await gate({ path: "fusion-should-not-exist.txt" }, name))?.block, name).toBe(true);
		}
		const readOnly = setup(true, "read-only");
		for (const name of ["write", "edit", "ast_edit", "bash", "powershell", "custom_write"])
			expect((await readOnly.gate({ path: "fusion-should-not-exist.txt" }, name))?.block, name).toBe(true);
		expect((await gate({}, "read"))?.block).not.toBe(true);
		expect((await gate({ query: "Collect root-cause evidence" }, "code_search"))?.block).not.toBe(true);
	});
	test("an unplanned Fusion worker is blocked before it takes ownership", async () => {
		const { runtime, gate } = setup(true);
		const result = await gate({ kind: "worker", prompt: "Fix it", writablePaths: ["."] });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("executionPlan");
		expect(runtime.state.snapshot().tasks).toHaveLength(0);
		expect(runtime.state.hasWritingTasks).toBe(false);
	});
	test("non-Fusion workers and exploration retain their existing gate", async () => {
		expect((await setup(false).gate({ kind: "worker" }))?.block).not.toBe(true);
		expect((await setup(true).gate({ kind: "explore" }))?.block).not.toBe(true);
	});
	test("a valid plan passes the gate but never bypasses read-only permission", async () => {
		const args = { kind: "worker", executionPlan: {
			steps: ["Implement decided change"], constraints: [], acceptanceCriteria: ["Regression passes"],
			verification: { mode: "run", checks: ["bun test regression.test.ts"] },
		} };
		expect((await setup(true).gate(args))?.block).not.toBe(true);
		const readOnly = setup(true, "read-only");
		// task remains available for read-only exploration; state rejects the write kind.
		expect(() => readOnly.runtime.state.startTask({
			...args, kind: "worker", description: "Fix", prompt: "Implement", writablePaths: ["."],
			executionPlan: { ...args.executionPlan, verification: { mode: "run", checks: ["bun test"] } },
		})).toThrow("read-only permission");
		expect(readOnly.runtime.state.snapshot().tasks).toHaveLength(0);
	});
});

describe("selectFastContextModel", () => {
	test("keeps risky code location on Sidekick with either routing setting", () => {
		for (const adaptiveRouting of [true, false]) {
			const configured = { ...fusion!, config: { ...fusion!.config, adaptiveRouting } };
			const pick = selectFastContextModel(parent, "high", configured, "Locate authentication, payments and concurrency permission boundary");
			expect(pick.model).toBe(sidekick);
			expect(pick.requestedThinkingLevel).toBe("medium");
		}
	});
	test("uses the Fusion Sidekick when Fusion is on", () => {
		const pick = selectFastContextModel(parent, "high", fusion);
		expect(pick.model).toBe(sidekick);
		expect(pick.requestedThinkingLevel).toBe("medium");
	});
	test("otherwise follows the session's model and thinking level", () => {
		const pick = selectFastContextModel(parent, "high", null);
		expect(pick.model).toBe(parent);
		expect(pick.requestedThinkingLevel).toBe("high");
	});
});

describe("Fusion MCP delegation and Sidekick execution", () => {
	const createFakeMcpTool = (name = "mcp__demo__echo") => {
		let callCount = 0;
		let lastParams: unknown;
		const tool: ToolDefinition = {
			name,
			label: "demo/echo",
			description: "Echo parameters test tool",
			parameters: { type: "object", properties: { query: { type: "string" } } } as never,
			execute: (async (_id: string, params: any, signal?: AbortSignal) => {
				if (signal?.aborted) throw new Error("MCP call aborted");
				callCount++;
				lastParams = params;
				return { content: [{ type: "text", text: `result: ${params?.query}` }], details: {} };
			}) as any,
		};
		return { tool, getCallCount: () => callCount, getLastParams: () => lastParams };
	};

	const setupWithMcp = (enabled: boolean, permission: "auto" | "read-only" = "auto", mcpTools: ToolDefinition[] = []) => {
		const options = {
			cwd: process.cwd(),
			initialFusion: enabled ? fusion.config : null,
			initialMode: enabled ? "agent" : "multitask",
			getPermission: () => permission,
			debugRoot: process.cwd(),
			getMcpTools: () => mcpTools,
			sessionManager: { getBranch: () => [], appendCustomEntry: () => undefined },
			modelRuntime: {
				getAvailableSnapshot: () => [parent, sidekick],
			},
			onChange: () => undefined,
			onModeChange: () => undefined,
		} as unknown as ConstructorParameters<typeof WorkflowRuntime>[0];
		const runtime = new WorkflowRuntime(options);
		const session = {
			agent: {},
			model: parent,
			messages: [],
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
		} as unknown as AgentSession;
		runtime.attach(session);
		return { runtime, session };
	};

	test("Fusion Lead receives bounded delegatedMcpTools summary in context", () => {
		const { tool } = createFakeMcpTool("mcp__test__tool");
		const { runtime } = setupWithMcp(true, "auto", [tool]);
		const ctx = runtime.context();
		expect(ctx.delegatedMcpTools).toBeDefined();
		expect(ctx.delegatedMcpTools).toHaveLength(1);
		expect(ctx.delegatedMcpTools![0].name).toBe("mcp__test__tool");
		expect(ctx.delegatedMcpTools![0].description).toBe("Echo parameters test tool");
	});

	test("sensitive and routine implementation both use Sidekick without compaction", async () => {
		const { runtime } = setupWithMcp(true);
		const requested: string[] = [];
		let created = 0;
		const mockSession: any = {
			model: parent, agent: {}, messages: [], sessionManager: { getBranch: () => [] },
			setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
			setModel: async (model: typeof parent) => { mockSession.model = model; },
			setThinkingLevel: () => undefined,
			abort: async () => undefined, dispose: () => undefined,
			prompt: async () => {
				requested.push(mockSession.model.id);
				mockSession.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
			},
		};
		const spy = spyOn(piCodingAgent, "createAgentSession").mockImplementation(async () => {
			created++;
			return { session: mockSession, extensionsResult: {} as any } as any;
		});
		try {
			const harness = runtime as unknown as {
				runHelper: (role: string, prompt: string, signal?: AbortSignal, scopes?: string[], onStep?: unknown, helperOptions?: unknown) => Promise<string>;
			};
			await harness.runHelper("agent", "Review security boundary", undefined, ["."], undefined,
				{ reuseFusionWorker: true, routing: new FusionRoutingState("auxiliary", "security boundary", true) });
			await harness.runHelper("agent", "Edit a label", undefined, ["."], undefined,
				{ reuseFusionWorker: true, routing: new FusionRoutingState("auxiliary", "Edit a label", true) });
			expect(created).toBe(1);
			expect(requested).toEqual([sidekick.id, sidekick.id]);
		} finally {
			spy.mockRestore();
			runtime.dispose();
			await runtime.whenSettled();
		}
	});

	test("Fast Context stops tool exploration after twelve calls", async () => {
		const { runtime } = setupWithMcp(true);
		let capturedOptions: any;
		let finishPrompt!: () => void;
		const pending = new Promise<void>((resolve) => { finishPrompt = resolve; });
		const mockSession: any = {
			model: sidekick, agent: {}, messages: [], sessionManager: { getBranch: () => [] },
			setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
			abort: async () => undefined, dispose: () => undefined,
			prompt: async () => {
				await pending;
				mockSession.messages = [{ role: "assistant", content: [{ type: "text", text: "locations" }], stopReason: "stop" }];
			},
		};
		const spy = spyOn(piCodingAgent, "createAgentSession").mockImplementation(async (options) => {
			capturedOptions = options;
			return { session: mockSession, extensionsResult: {} as any } as any;
		});
		try {
			const harness = runtime as unknown as {
				runHelper: (role: string, prompt: string, signal?: AbortSignal, scopes?: string[], onStep?: unknown, helperOptions?: unknown) => Promise<string>;
			};
			const run = harness.runHelper("subagent", "Locate authentication permission boundary", undefined, [], undefined,
				{ fastContext: true, model: sidekick, routing: new FusionRoutingState("auxiliary", "authentication permission boundary", true) });
			for (let i = 0; i < 50 && !mockSession.agent.beforeToolCall; i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			expect(capturedOptions.model).toBe(sidekick);
			expect(capturedOptions.afterCompaction).toBeUndefined();
			const call = (id: number) => mockSession.agent.beforeToolCall({
				toolCall: { name: "read", id: `call-${id}`, arguments: { path: "README.md" } },
				args: { path: "README.md" },
			} as never);
			for (let i = 0; i < 12; i++) expect(await call(i)).toBeUndefined();
			expect(await call(12)).toMatchObject({ block: true, reason: expect.stringContaining("12-tool") });
			finishPrompt();
			await run;
		} finally {
			finishPrompt();
			spy.mockRestore();
			runtime.dispose();
			await runtime.whenSettled();
		}
	});

	test("exclusive whole-workspace Sidekick worker can execute injected MCP tool", async () => {
		const { tool, getCallCount } = createFakeMcpTool("mcp__demo__run");
		const { runtime } = setupWithMcp(true, "auto", [tool]);

		let capturedOptions: any;
		let finishPrompt!: () => void;
		const promptWait = new Promise<void>((resolve) => {
			finishPrompt = resolve;
		});
		const mockSession: any = {
			model: sidekick,
			agent: {},
			messages: [],
			sessionManager: { getBranch: () => [] },
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			abort: async () => undefined,
			dispose: () => undefined,
			prompt: async () => {
				await promptWait;
				mockSession.messages = [
					{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
				];
			},
		};
		const spy = spyOn(piCodingAgent, "createAgentSession").mockImplementation(async (opts) => {
			capturedOptions = opts;
			return { session: mockSession, extensionsResult: {} as any } as any;
		});

		try {
			const harness = runtime as unknown as {
				runHelper: (role: string, prompt: string, signal?: AbortSignal, scopes?: string[], onStep?: unknown, helperOptions?: unknown) => Promise<string>;
			};

			const runPromise = harness.runHelper("agent", "Do task", undefined, ["."], undefined, { reuseFusionWorker: true });

			// Wait until createAgentSession completes
			for (let i = 0; i < 50 && !capturedOptions; i++) {
				await new Promise((r) => setTimeout(r, 5));
			}

			expect(capturedOptions).toBeDefined();
			const customTools = (capturedOptions?.customTools ?? []) as ToolDefinition[];
			const mcpWrapper = customTools.find((t) => t.name === "mcp__demo__run");
			expect(mcpWrapper).toBeDefined();

			// Test beforeToolCall gate: exclusive worker should NOT be blocked during active lease
			const beforeCheck = await mockSession.agent!.beforeToolCall!({
				toolCall: { name: "mcp__demo__run", id: "call-1", arguments: { query: "hello" } },
				args: { query: "hello" },
			} as never);
			expect(beforeCheck).toBeUndefined();

			// Test executing the tool: should call underlying MCP tool
			const res = await (mcpWrapper!.execute as any)("call-1", { query: "hello" });
			expect(getCallCount()).toBe(1);
			expect(res).toEqual({ content: [{ type: "text", text: "result: hello" }], details: {} });

			// Complete the helper run
			finishPrompt();
			await runPromise;

			// After lease is released, execution should be rejected
			await expect((mcpWrapper!.execute as any)("call-2", { query: "hello" })).rejects.toThrow("Helper cancelled or idle");
		} finally {
			spy.mockRestore();
		}
	});

	test("local-scope worker, read-only worker, and fast-context reject MCP tool", async () => {
		const { tool } = createFakeMcpTool("mcp__demo__run");

		let capturedOptions: any;
		const mockSession: any = {
			model: sidekick,
			agent: {},
			messages: [],
			sessionManager: { getBranch: () => [] },
			setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined,
			abort: async () => undefined,
			dispose: () => undefined,
			prompt: async () => {
				mockSession.messages = [
					{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
				];
			},
		};
		const spy = spyOn(piCodingAgent, "createAgentSession").mockImplementation(async (opts) => {
			capturedOptions = opts;
			return { session: mockSession, extensionsResult: {} as any } as any;
		});

		try {
			// 1. Local worker (scopes: ["src/file.ts"])
			const local = setupWithMcp(true, "auto", [tool]);
			const localHarness = local.runtime as unknown as {
				runHelper: (role: string, prompt: string, signal?: AbortSignal, scopes?: string[], onStep?: unknown, helperOptions?: unknown) => Promise<string>;
			};
			void localHarness.runHelper("agent", "Do local", undefined, ["src/file.ts"], undefined, { reuseFusionWorker: false });
			for (let i = 0; i < 50 && !capturedOptions; i++) {
				await new Promise((r) => setTimeout(r, 5));
			}

			expect(capturedOptions).toBeDefined();
			// MCP tool should not be registered in customTools for local worker
			expect((capturedOptions?.customTools ?? []).some((t: any) => t.name === "mcp__demo__run")).toBe(false);

			// 2. Read-only worker
			capturedOptions = undefined;
			const ro = setupWithMcp(true, "read-only", [tool]);
			const roHarness = ro.runtime as unknown as {
				runHelper: (role: string, prompt: string, signal?: AbortSignal, scopes?: string[], onStep?: unknown, helperOptions?: unknown) => Promise<string>;
			};
			void roHarness.runHelper("agent", "Do ro", undefined, ["."], undefined, { reuseFusionWorker: false });
			for (let i = 0; i < 50 && !capturedOptions; i++) {
				await new Promise((r) => setTimeout(r, 5));
			}
			expect(capturedOptions).toBeDefined();
			expect((capturedOptions?.customTools ?? []).some((t: any) => t.name === "mcp__demo__run")).toBe(false);

			// 3. Fast Context
			capturedOptions = undefined;
			const fc = setupWithMcp(true, "auto", [tool]);
			const fcHarness = fc.runtime as unknown as {
				runHelper: (role: string, prompt: string, signal?: AbortSignal, scopes?: string[], onStep?: unknown, helperOptions?: unknown) => Promise<string>;
			};
			void fcHarness.runHelper("subagent", "Search", undefined, [], undefined, { fastContext: true });
			for (let i = 0; i < 50 && !capturedOptions; i++) {
				await new Promise((r) => setTimeout(r, 5));
			}
			expect(capturedOptions).toBeDefined();
			expect((capturedOptions?.customTools ?? []).some((t: any) => t.name === "mcp__demo__run")).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	test("single-model mode does not expose MCP tools through worker delegation", () => {
		const { tool } = createFakeMcpTool("mcp__demo__run");
		const { runtime } = setupWithMcp(false, "auto", [tool]);
		expect(runtime.context().delegatedMcpTools).toBeUndefined();
	});
});
