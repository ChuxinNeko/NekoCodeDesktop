import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { attachTruncationRecovery, MAX_STREAM_RECOVERIES, MAX_TRUNCATION_NUDGES, TRUNCATION_GUIDANCE } from "../../src/main/truncation-recovery";

async function withSession(run: (session: AgentSession, runtime: ModelRuntime) => Promise<void>) {
	const cwd = await mkdtemp(join(tmpdir(), "main-long-work-"));
	let session: AgentSession | undefined;
	try {
		const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
			modelsStorePath: join(cwd, "models.json"), allowModelNetwork: false });
		await runtime.setRuntimeApiKey("anthropic", "test-only");
		session = (await createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(cwd), model: getModel("anthropic", "claude-sonnet-4-5")! })).session;
		await run(session, runtime);
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}

function response(reason: AssistantMessage["stopReason"], content = "draft", errorMessage?: string) {
	const message = { ...fauxAssistantMessage(content), stopReason: reason, errorMessage };
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		if (reason === "error" || reason === "aborted") stream.push({ type: "error", reason, error: message });
		else stream.push({ type: "done", reason: reason as "stop" | "length" | "toolUse", message });
	});
	return stream;
}

describe("main session long work recovery", () => {
	test("continues a text-only length stop in the same run without persisting a synthetic prompt", async () => {
		await withSession(async (session, runtime) => {
			let requests = 0;
			const contexts: string[] = [];
			runtime.streamSimple = (_model, context) => {
				requests++;
				contexts.push(JSON.stringify(context.messages));
				return response(requests === 1 ? "length" : "stop");
			};
			attachTruncationRecovery(session, () => { throw new Error("Unexpected recovery exhaustion"); });
			await session.prompt("Finish a long answer");
			expect(requests).toBe(2);
			expect(contexts[1]).toContain(TRUNCATION_GUIDANCE.slice(0, 30));
			expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		});
	});

	test.each(["error", "aborted"] as const)("recovers a provider %s and keeps the partial text", async (reason) => {
		await withSession(async (session, runtime) => {
			let requests = 0;
			runtime.streamSimple = (_model, context) => {
				requests++;
				if (requests === 2) expect(JSON.stringify(context.messages)).toContain("unfinished answer");
				expect(requests).toBeLessThanOrEqual(2);
				return requests === 1 ? response(reason, "unfinished answer", "aborted") : response("stop", "finished");
			};
			attachTruncationRecovery(session, () => undefined);
			await session.prompt("Continue until complete");
			expect(requests).toBe(2);
			expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(session.agent.state.errorMessage).toBeUndefined();
		});
	});

	test("never executes truncated or interrupted tool arguments and preserves successful operations", async () => {
		await withSession(async (session, runtime) => {
			const executed: number[] = [];
			session.setCustomTools([{ name: "save", label: "save", description: "save", parameters: Type.Object({ n: Type.Number() }),
				execute: async (_id, args) => { executed.push((args as { n: number }).n); return { content: [{ type: "text", text: "saved" }], details: {} }; } }]);
			session.setActiveToolsByName(["save"]);
			let requests = 0;
			runtime.streamSimple = () => {
				const n = ++requests;
				expect(n).toBeLessThanOrEqual(11);
				if (n === 11) return response("stop", "completed");
				const stopReason = n % 3 === 2 ? "length" : n % 3 === 0 ? "error" : "toolUse";
				const message: AssistantMessage = { ...fauxAssistantMessage(""), stopReason, errorMessage: stopReason === "error" ? "aborted" : undefined,
					content: [{ type: "toolCall", id: `save-${n}`, name: "save", arguments: { n } }] };
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: stopReason, message });
				});
				return stream;
			};
			attachTruncationRecovery(session, () => undefined);
			await session.prompt("Save incrementally");
			expect(executed).toEqual([1, 4, 7, 10]);
			expect(requests).toBe(11);
		});
	});

	test.each(["length", "error"] as const)("bounds repeated %s failures and resets the budget for a new user prompt", async (reason) => {
		await withSession(async (session, runtime) => {
			const notices: string[] = [];
			let requests = 0;
			runtime.streamSimple = () => { requests++; return response(reason, "draft", reason === "error" ? "aborted" : undefined); };
			attachTruncationRecovery(session, (notice) => notices.push(notice));
			const attempts = 1 + (reason === "length" ? MAX_TRUNCATION_NUDGES : MAX_STREAM_RECOVERIES);
			await session.prompt("Long task");
			expect(requests).toBe(attempts);
			await session.prompt("Try again");
			expect(requests).toBe(attempts * 2);
			expect(notices).toHaveLength(2);
		});
	});

	test("does not recover user cancellation or authentication failures", async () => {
		for (const cancel of [false, true]) await withSession(async (session, runtime) => {
			let requests = 0;
			runtime.streamSimple = (_model, _context, options) => {
				requests++;
				if (cancel) {
					const stream = createAssistantMessageEventStream();
					options!.signal!.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted",
						error: { ...fauxAssistantMessage(""), stopReason: "aborted", errorMessage: "aborted" } }), { once: true });
					queueMicrotask(() => void session.abort());
					return stream;
				}
				return response("error", "", "401 Unauthorized");
			};
			attachTruncationRecovery(session, () => undefined);
			await session.prompt("Work");
			expect(requests).toBe(1);
		});
	});
});
