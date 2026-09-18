import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type Context, type Tool, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { antigravityModels, buildAntigravityRequest, functionNames, type AntigravityMessage } from "./antigravity-request";
import { cleanAntigravityToolSchema, restoreAntigravityToolArguments } from "./antigravity-schema";
import { claudeSignature, geminiSignature, GEMINI_SIGNATURE_BYPASS } from "./antigravity-signatures";
import { AntigravityStream } from "./antigravity-stream";
import { ANTIGRAVITY_IDENTITY } from "./antigravity";
import { registerAntigravityProvider } from "./antigravity-provider";
import type { AntigravityOAuthService } from "./antigravity-oauth-service";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Content, Part } from "./antigravity-request";

const geminiSig = Buffer.from([0x12, 5, 0x0a, 3, 1, 2, 3]).toString("base64");
const claudeInner = Buffer.from([0x12, 4, 0x0a, 2, 8, 11]).toString("base64");
const claudeSig = Buffer.from(claudeInner).toString("base64");
const tool: Tool = { name: "read_file", description: "Read file", parameters: Type.Object({ path: Type.String() }) };
const context: Context = { systemPrompt: "You are a coding assistant", messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [tool] };
const models = antigravityModels();
const gemini = models.find((model) => model.id === "gemini-3-flash")!;
const claude = models.find((model) => model.id === "claude-sonnet-4-6")!;

function sse(events: unknown[], fragmented = false): Response {
	const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
	return new Response(new ReadableStream({ start(controller) {
		if (fragmented) for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
		else controller.enqueue(bytes);
		controller.close();
	} }), { headers: { "content-type": "text/event-stream" } });
}
function fixture(responses: Response[]) {
	const calls: unknown[] = [];
	const abort = new AbortController();
	const oauth = {
		requestContext: async () => ({ accessToken: "secret-token", projectId: "project", scope: "account", identity: ANTIGRAVITY_IDENTITY, signal: abort.signal }),
		sendModelRequest: async (payload: unknown) => { calls.push(payload); if (!responses.length) throw new Error("unexpected request"); return responses.shift()!; },
	};
	const adapter = new AntigravityStream(oauth);
	const run = async (model = gemini, ctx = context, options: Parameters<AntigravityStream["run"]>[3] = {}) => {
		const stream = createAssistantMessageEventStream();
		await adapter.run(stream, model, ctx, options);
		return stream.result();
	};
	return { run, calls, abort, oauth, adapter };
}

describe("Antigravity model request contract", () => {
	test("catalog preserves reference limits and excludes image-output models", () => {
		expect(models).toHaveLength(11);
		expect(claude.contextWindow).toBe(200000);
		expect(claude.maxTokens).toBe(64000);
		expect(gemini.contextWindow).toBe(1048576);
		expect(models.some((m) => m.id.includes("image"))).toBe(false);
	});
	test("envelope, stable session and Claude settings follow executor buildRequest", () => {
		const { payload } = buildAntigravityRequest(claude.id, context, { reasoning: "high", maxTokens: 50000 }, "project", "account");
		expect(payload).toMatchObject({ project: "project", model: claude.id, userAgent: "antigravity", requestType: "agent" });
		expect(payload.requestId).toMatch(/^agent-[\da-f-]{36}$/);
		expect(payload.request.sessionId).toBe(`-${createHash("sha256").update("hello").digest().readBigUInt64BE(0) & 0x7fffffffffffffffn}`);
		expect(payload.request.generationConfig).toEqual({ maxOutputTokens: 50000, thinkingConfig: { thinkingBudget: 24576, includeThoughts: true } });
		expect(payload.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
		expect(payload.request.systemInstruction).toEqual({ parts: [{ text: context.systemPrompt! }] });
		expect(JSON.stringify(payload)).not.toContain("safetySettings");
	});
	test("Gemini uses thinkingLevel, omits maxOutputTokens and normalizes boundary turns", () => {
		const result = buildAntigravityRequest(gemini.id, context, { reasoning: "medium", maxTokens: 8 }, "project", "account");
		expect(result.payload.request.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "medium", includeThoughts: true } });
		expect(result.payload.request.toolConfig).toBeUndefined();
		expect(buildAntigravityRequest(gemini.id, context, {}, "p", "a").payload.request.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false } });
	});
	test("schema cleaning touches schema fields, preserves property names and matches VALIDATED placeholders", () => {
		const input = { type: "object", properties: { title: { type: "string", enum: ["a", "b"] }, count: { type: "integer", minimum: 1 }, tags: { type: "array" } }, additionalProperties: false };
		const clean = cleanAntigravityToolSchema(input, true);
		expect(clean).toEqual({ type: "object", description: "No extra properties allowed", properties: {
			title: { type: "string", description: "Allowed: a, b" }, count: { type: "integer", description: "minimum: 1" }, tags: { type: "array", items: { type: "string" } }, _: { type: "boolean" },
		}, required: ["_"] });
		expect(input.properties.title.enum).toEqual(["a", "b"]);
		expect(cleanAntigravityToolSchema({ type: "object", properties: {} }, true)).toEqual({ type: "object", properties: { reason: { type: "string", description: "Brief explanation of why you are calling this tool" } }, required: ["reason"] });
	});
	test("local schema refs, unions and recursive refs are bounded", () => {
		const input = { $defs: { Item: { type: "object", properties: { next: { $ref: "#/$defs/Item" } } } }, type: "object", properties: { item: { $ref: "#/$defs/Item" }, value: { anyOf: [{ type: "string" }, { type: "null" }] } } };
		const clean = cleanAntigravityToolSchema(input, false);
		expect(JSON.stringify(clean)).not.toContain("$ref");
		expect(JSON.stringify(clean)).toContain("nullable");
	});
	test("restores only synthesized placeholder arguments, including nested objects", () => {
		const schema = Type.Object({
			reason: Type.String(), _: Type.Boolean(),
			optional: Type.Object({ path: Type.Optional(Type.String()) }, { additionalProperties: false }),
			items: Type.Array(Type.Object({}, { additionalProperties: false })),
		}, { additionalProperties: false });
		const raw = { reason: "user defined", _: false, optional: { path: "a.ts", _: true }, items: [{ reason: "placeholder" }] };
		expect(restoreAntigravityToolArguments(raw, schema, true)).toEqual({ reason: "user defined", _: false, optional: { path: "a.ts" }, items: [{}] });
		expect(raw.optional._).toBe(true);
		expect(raw.items[0]!.reason).toBe("placeholder");
	});
	test("colliding function names receive stable disambiguation", () => {
		const names = functionNames({ ...context, tools: [{ ...tool, name: "read file" }, { ...tool, name: "read@file" }] });
		expect(new Set(names.values()).size).toBe(2);
		for (const mapped of names.values()) expect(mapped).toMatch(/^read_file_[a-f0-9]{12}$/);
	});
	test("signature families cannot be confused and Claude is normalized to double base64", () => {
		expect(geminiSignature(geminiSig)).toBe(geminiSig);
		expect(claudeSignature(geminiSig)).toBeUndefined();
		expect(claudeSignature(claudeInner)).toBe(claudeSig);
		expect(geminiSignature(claudeSig)).toBeUndefined();
		expect(geminiSignature("dW5rbm93bg==")).toBeUndefined();
	});
});

describe("Antigravity streaming and replay", () => {
	test("HTTP 403 exposes upstream details without reflecting the access token", async () => {
		const f = fixture([Response.json({ error: { code: 403, message: "Service is disabled for this account", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED", tokenEcho: "secret-token" }] } }, { status: 403 })]);
		const result = await f.run();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("HTTP 403");
		expect(result.errorMessage).toContain("Service is disabled for this account");
		expect(result.errorMessage).toContain('"status": "PERMISSION_DENIED"');
		expect(result.errorMessage).toContain("SERVICE_DISABLED");
		expect(result.errorMessage).not.toContain("secret-token");
		expect(f.calls).toHaveLength(1);
	});
	test("errors inside a successful SSE response expose provider diagnostics", async () => {
		const f = fixture([sse([{ error: { code: 403, message: "Account verification required", status: "PERMISSION_DENIED" } }])]);
		const result = await f.run();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Account verification required");
	});
	test("detached Gemini signatures attach to their original tool call", async () => {
		const f = fixture([sse([
			{ response: { candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "x" } } }] } }] } },
			{ response: { candidates: [{ content: { parts: [{ thoughtSignature: geminiSig }] }, finishReason: "STOP" }] } },
		])]);
		const output = await f.run() as AntigravityMessage;
		expect(output.stopReason).toBe("toolUse");
		expect(output.antigravity?.parts).toHaveLength(1);
		expect(output.antigravity?.parts[0]?.thoughtSignature).toBe(geminiSig);
		expect(output.content[0]).toMatchObject({ type: "toolCall", thoughtSignature: geminiSig });
	});
	test("cancellation during a stream reports aborted and discards replay state", async () => {
		const f = fixture([]);
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } });
		f.oauth.sendModelRequest = async () => response;
		const pending = f.run();
		controller.enqueue(new TextEncoder().encode('data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n'));
		f.abort.abort(); controller.error(new Error("cancelled"));
		const output = await pending;
		expect(output.stopReason).toBe("aborted");
		expect((output as AntigravityMessage).antigravity).toBeUndefined();
	});
	test("split UTF-8, thinking, tool calls and split usage survive a complete round trip", async () => {
		const f = fixture([sse([
			{ response: { candidates: [{ content: { parts: [{ text: "分析", thought: true }] } }] } },
			{ response: { candidates: [{ content: { parts: [{ text: "", thought: true, thoughtSignature: geminiSig }] } }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 25 } } },
			{ response: { responseId: "resp-1", candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.ts", title: "keep", default: 7 } }, thoughtSignature: geminiSig }] }, finishReason: "STOP" }], usageMetadata: { candidatesTokenCount: 5, thoughtsTokenCount: 10, totalTokenCount: 115 } } },
		], true)]);
		const output = await f.run();
		expect(output.stopReason).toBe("toolUse");
		expect(output.usage).toMatchObject({ input: 75, output: 15, cacheRead: 25, reasoning: 10, totalTokens: 115 });
		const call = output.content.find((p) => p.type === "toolCall")!;
		const next: Context = { ...context, messages: [...context.messages, JSON.parse(JSON.stringify(output)), { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 }] };
		const request = buildAntigravityRequest(gemini.id, next, {}, "project", "account").payload.request;
		const assistant = request.contents.find((c) => c.role === "model")!;
		expect(assistant.parts[0]).toEqual({ text: "分析", thought: true, thoughtSignature: geminiSig });
		expect(assistant.parts[1]?.functionCall?.args).toEqual({ path: "a.ts", title: "keep", default: 7 });
		expect(assistant.parts[1]?.thoughtSignature).toBe(geminiSig);
		expect(request.contents.at(-1)?.parts[0]?.functionResponse?.name).toBe("read_file");
		const foreign = buildAntigravityRequest(gemini.id, next, {}, "project", "another-account").payload.request;
		expect(foreign.contents.find((c) => c.role === "model")?.parts[0]?.thoughtSignature).toBe(GEMINI_SIGNATURE_BYPASS);
	});
	test("unsigned parallel sibling calls remain unsigned", () => {
		const msg: AssistantMessage = { role: "assistant", provider: "foreign", model: "foreign", api: "antigravity", timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "read_file", arguments: { path: "a" } }, { type: "toolCall", id: "2", name: "read_file", arguments: { path: "b" } }] };
		const req = buildAntigravityRequest(gemini.id, { ...context, messages: [...context.messages, msg] }, {}, "p", "a");
		const parts = req.payload.request.contents[1]!.parts;
		expect(parts[0]!.thoughtSignature).toBe(GEMINI_SIGNATURE_BYPASS);
		expect(parts[1]!.thoughtSignature).toBeUndefined();
		expect(req.payload.request.contents.at(-1)).toEqual({ role: "user", parts: [{ text: "" }] });
	});
	test("Claude replay only retains compatible signed thinking, never tool signatures", async () => {
		const f = fixture([sse([{ response: { candidates: [{ content: { parts: [{ thought: true, text: "reason", thoughtSignature: claudeInner }, { text: "answer" }] }, finishReason: "STOP" }] } }])]);
		const output = await f.run(claude);
		const next = buildAntigravityRequest(claude.id, { ...context, messages: [...context.messages, output, { role: "user", content: "continue", timestamp: 2 }] }, {}, "project", "account");
		expect(next.payload.request.contents[1]?.parts[0]?.thoughtSignature).toBe(claudeSig);
	});
	test("empty, malformed and truncated streams fail without a success event", async () => {
		for (const response of [sse([]), sse([{ response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] } }]), new Response("data: {bad}\n\n", { headers: { "content-type": "text/event-stream" } })]) {
			const output = await fixture([response]).run();
			expect(output.stopReason).toBe("error");
			expect((output as AntigravityMessage).antigravity).toBeUndefined();
		}
	});
	test("HTTP 429 is one attempt and blocks subsequent requests during the cooldown", async () => {
		const f = fixture([Response.json({ error: { details: [{ retryDelay: "60s" }] } }, { status: 429 })]);
		expect((await f.run()).errorMessage).toContain("429");
		expect((await f.run()).errorMessage).toContain("冷却");
		expect(f.calls).toHaveLength(1);
	});
	test("callbacks run, caller headers cannot alter the wire identity, and payload replacement fails closed", async () => {
		const f = fixture([sse([{ response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] } }])]);
		let payloads = 0, responses = 0;
		expect((await f.run(gemini, context, { onPayload: () => { payloads++; }, onResponse: () => { responses++; }, headers: { "User-Agent": "wrong" } })).stopReason).toBe("stop");
		expect(payloads).toBe(1); expect(responses).toBe(1);
		expect((await f.run(gemini, context, { onPayload: () => ({ project: "wrong" }) })).stopReason).toBe("error");
		expect(f.calls).toHaveLength(1);
	});
});

test("PI runtime registers models with stored OAuth, invokes the custom stream, and hides them on logout", async () => {
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const f = fixture([sse([{ response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] } }])]);
	let signedIn = true;
	await registerAntigravityProvider(runtime, { ...f.oauth, list: () => ({ signedIn }) } as unknown as AntigravityOAuthService);
	const model = runtime.getModel("antigravity", "gemini-3-flash")!;
	const available = await runtime.getAvailable("antigravity");
		expect(available).toHaveLength(11);
	const result = await runtime.completeSimple(model, context);
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "OK" });
	signedIn = false;
	await runtime.refresh({ allowNetwork: false, providers: ["antigravity"] });
		expect(await runtime.getAvailable("antigravity")).toHaveLength(0);
});

describe("Antigravity full PI tool execution loop", () => {
	for (const model of [gemini, claude]) {
		for (const scenario of ["parallel", "tool-failure", "invalid-arguments", "unknown-tool", "truncated", "strict-placeholder"] as const) {
			test(`${model.id}: ${scenario} executes or rejects tools and sends results back`, async () => {
				const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
				const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
				const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
				const empty = scenario === "strict-placeholder";
				const executed: { id: string; args: unknown }[] = [];
				const tools: AgentTool[] = [{
					name: "inspect", label: "Inspect", description: "Read simulated data",
					parameters: empty ? Type.Object({}, { additionalProperties: false }) : Type.Object({ path: Type.String() }, { additionalProperties: false }),
					execute: async (id, args) => {
						executed.push({ id, args });
						if (scenario === "tool-failure") throw new Error("simulated missing file");
						return { content: [{ type: "text", text: empty ? "ready" : `read:${(args as { path: string }).path}` }], details: {} };
					},
				}];
				const args = empty ? (model === claude ? { reason: "inspect state" } : {}) : scenario === "invalid-arguments" ? {} : { path: "first.txt" };
				const parts: Part[] = [
					...(model === claude ? [{ text: "Need to inspect", thought: true, thoughtSignature: claudeSig }] : []),
					{ functionCall: { id: "native-call-1", name: scenario === "unknown-tool" ? "missing_tool" : "inspect", args }, ...(model === gemini ? { thoughtSignature: geminiSig } : {}) },
					...(scenario === "parallel" ? [{ functionCall: { id: "native-call-2", name: "inspect", args: { path: "second.txt" } } }] : []),
				];
				const f = fixture([
					sse([{ response: { candidates: [{ content: { parts }, finishReason: scenario === "truncated" ? "MAX_TOKENS" : "STOP" }] } }], true),
					sse([{ response: { candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] } }]),
				]);
				await registerAntigravityProvider(runtime, { ...f.oauth, list: () => ({ signedIn: true }) } as unknown as AntigravityOAuthService);
				const agent = new Agent({
					initialState: { model: runtime.getModel("antigravity", model.id)!, tools, systemPrompt: "Inspect data and report" },
					streamFn: (m, ctx, options) => runtime.streamSimple(m, ctx, options), toolExecution: "parallel",
				});
				const ended: boolean[] = [];
				agent.subscribe((event) => { if (event.type === "tool_execution_end") ended.push(event.isError); });
				await agent.prompt("Inspect data");
				expect(f.calls).toHaveLength(2);
				const followup = f.calls[1] as { request: { contents: Content[] } };
				const results = followup.request.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse).map((p) => p.functionResponse!);
				expect(results.map((p) => p.id)).toEqual(scenario === "parallel" ? ["native-call-1", "native-call-2"] : ["native-call-1"]);
				if (scenario === "parallel") {
					expect(executed).toEqual([{ id: "native-call-1", args: { path: "first.txt" } }, { id: "native-call-2", args: { path: "second.txt" } }]);
					expect(results.map((p) => p.response)).toEqual([{ output: "read:first.txt" }, { output: "read:second.txt" }]);
					expect(ended).toEqual([false, false]);
				} else if (empty) {
					expect(executed).toEqual([{ id: "native-call-1", args: {} }]);
					expect(results[0]?.response).toEqual({ output: "ready" });
					const replayArgs = followup.request.contents.flatMap((c) => c.parts).find((p) => p.functionCall)?.functionCall?.args;
					expect(replayArgs).toEqual(model === claude ? { reason: "inspect state" } : {});
				} else {
					expect(executed).toHaveLength(scenario === "tool-failure" ? 1 : 0);
					expect(ended).toEqual([true]);
					expect(results[0]?.response.error).toBeString();
				}
				const last = agent.state.messages.at(-1) as AssistantMessage;
				expect(last.stopReason).toBe("stop");
				expect(last.content).toEqual([{ type: "text", text: "done", textSignature: undefined }]);
				const replay = followup.request.contents.find((c) => c.role === "model")!;
				expect(replay.parts[0]?.thoughtSignature).toBe(model === gemini ? geminiSig : claudeSig);
			});
		}
	}
});
