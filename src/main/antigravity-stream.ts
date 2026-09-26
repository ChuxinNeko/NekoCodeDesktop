import { randomUUID } from "node:crypto";
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions, Context, JsonObject, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { AntigravityMessage, Part } from "./antigravity-request";
import { buildAntigravityRequest } from "./antigravity-request";
import type { AntigravityOAuthService } from "./antigravity-oauth-service";
import { restoreAntigravityToolArguments } from "./antigravity-schema";
import { formatAntigravityError, readAntigravityErrorBody } from "./antigravity-error";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Incremental SSE parser: handles CRLF, split UTF-8 and multi-line data. */
export async function* antigravitySSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) throw new Error("Antigravity returned no response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	let eventLength = 0;
	const parse = () => {
		const payload = data.join("\n").trim(); data = []; eventLength = 0;
		if (!payload || payload === "[DONE]") return;
		let value: unknown;
		try { value = JSON.parse(payload); } catch { throw new Error("Invalid Antigravity stream JSON"); }
		if (!record(value)) throw new Error("Invalid Antigravity stream event");
		return value;
	};
	try {
		while (true) {
			const next = await reader.read();
			buffer += decoder.decode(next.value, { stream: !next.done });
			if (buffer.length > 16 * 1024 * 1024) throw new Error("Antigravity stream event exceeds the size limit");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
				if (!line) { const value = parse(); if (value) yield value; }
				else if (line.startsWith("data:")) {
					eventLength += line.length;
					if (eventLength > 16 * 1024 * 1024) throw new Error("Antigravity stream event exceeds the size limit");
					data.push(line.slice(5).replace(/^ /, ""));
				}
			}
			if (next.done) {
				if (buffer.trim().startsWith("data:")) data.push(buffer.trim().slice(5).trimStart());
				const value = parse(); if (value) yield value;
				break;
			}
		}
	} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** One upstream attempt; retry/cooldown never rewrites credentials or endpoints. */
export class AntigravityStream {
	private readonly cooldown = new Map<string, number>();
	constructor(private readonly oauth: Pick<AntigravityOAuthService, "requestContext" | "sendModelRequest">) {}

	async run(stream: AssistantMessageEventStream, model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<void> {
		const output: AntigravityMessage = {
			role: "assistant", content: [], api: "antigravity", provider: "antigravity", model: model.id, stopReason: "pending", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		let response: Response | undefined;
		let authSignal: AbortSignal | undefined;
		try {
			const auth = await this.oauth.requestContext(options?.signal); authSignal = auth.signal;
			const key = `${auth.scope}/${model.id}`;
			const remaining = (this.cooldown.get(key) ?? 0) - Date.now();
			if (remaining > 0) throw new Error(`Antigravity 配额冷却中，请在 ${Math.ceil(remaining / 1000)} 秒后重试`);
			this.cooldown.delete(key);
			const built = buildAntigravityRequest(model.id, context, options, auth.projectId, auth.scope);
			// Hooks may inspect the body. Replacements cannot bypass protocol checks.
			const replaced = await options?.onPayload?.(structuredClone(built.payload), model);
			if (replaced !== undefined && JSON.stringify(replaced) !== JSON.stringify(built.payload)) throw new Error("Antigravity does not allow overriding its protected request payload");
			auth.signal.throwIfAborted();
			response = await this.oauth.sendModelRequest(built.payload, auth);
			await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
			if (!response.ok) {
				const rawBody = await readAntigravityErrorBody(response);
				if (response.status === 429) {
					let delay = Number(response.headers.get("retry-after")) * 1000;
					let body: unknown;
					try { body = JSON.parse(rawBody); } catch { /* Non-JSON errors still display their body. */ }
					const details = record(body) && record(body.error) && Array.isArray(body.error.details) ? body.error.details : [];
					for (const detail of details) if (record(detail) && typeof detail.retryDelay === "string" && /^\d+(\.\d+)?s$/.test(detail.retryDelay)) delay = Math.max(delay, parseFloat(detail.retryDelay) * 1000);
					this.cooldown.set(key, Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60_000));
				}
				throw new Error(formatAntigravityError(`Antigravity 请求失败（HTTP ${response.status}）`, rawBody, [auth.accessToken]));
			}
			if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Antigravity returned an unexpected response format");
			output.antigravity = { scope: auth.scope, model: model.id, parts: [] };
			stream.push({ type: "start", partial: output });
			let block: TextContent | ThinkingContent | undefined;
			let index = -1;
			const closeBlock = () => {
				if (block?.type === "text") stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
				else if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
				block = undefined;
			};
			const numbers: Record<string, number> = {};
			let terminal = false;
			let visible = false;
			for await (const event of antigravitySSE(response)) {
				auth.signal.throwIfAborted();
				const body = record(event.response) ? event.response : event;
				if (event.error || body.error) throw new Error(formatAntigravityError("Antigravity 流式响应错误", JSON.stringify(event), [auth.accessToken]));
				if (typeof body.responseId === "string") output.responseId ||= body.responseId;
				const candidates = Array.isArray(body.candidates) ? body.candidates : [];
				const candidate = record(candidates[0]) ? candidates[0] : undefined;
				const content = record(candidate?.content) ? candidate.content : undefined;
				const parts = Array.isArray(content?.parts) ? content.parts : [];
				for (const raw of parts) {
					if (!record(raw)) throw new Error("Invalid Antigravity response part");
					const part = structuredClone(raw) as Part;
					const previous = output.antigravity.parts.at(-1);
					// Detached Gemini signatures belong to the preceding function call.
					if (!model.id.includes("claude") && part.thoughtSignature && !part.text?.trim() && !part.functionCall && previous?.functionCall && !previous.thoughtSignature) {
						previous.thoughtSignature = part.thoughtSignature;
						const last = output.content.at(-1);
						if (last?.type === "toolCall") last.thoughtSignature = part.thoughtSignature;
						continue;
					}
					if (typeof part.text === "string" && previous?.text !== undefined && !!previous.thought === !!part.thought && !previous.thoughtSignature && !part.functionCall && !previous.functionCall) {
						previous.text += part.text;
						if (part.thoughtSignature) previous.thoughtSignature = part.thoughtSignature;
					} else if (part.thoughtSignature && part.text === undefined && !part.functionCall && previous?.text !== undefined && !previous.thoughtSignature) {
						previous.thoughtSignature = part.thoughtSignature;
					} else output.antigravity.parts.push(part);
					if (typeof part.text === "string" || part.thoughtSignature && !part.functionCall) {
						const type = part.thought || (part.text === undefined && part.thoughtSignature && block?.type === "thinking") ? "thinking" : "text";
						if (block?.type !== type || (block.type === "text" ? block.textSignature : block.thinkingSignature)) {
							closeBlock(); block = type === "thinking" ? { type, thinking: "" } : { type, text: "" };
							output.content.push(block); index = output.content.length - 1;
							stream.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: output });
						}
						const text = part.text ?? "";
						visible ||= text.length > 0;
						if (block.type === "text") {
							block.text += text; block.textSignature = part.thoughtSignature ?? block.textSignature;
							stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
						} else {
							block.thinking += text; block.thinkingSignature = part.thoughtSignature ?? block.thinkingSignature;
							stream.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: output });
						}
					}
					if (part.functionCall) {
						closeBlock();
						if (!record(part.functionCall) || typeof part.functionCall.name !== "string" || !record(part.functionCall.args ?? {})) throw new Error("Invalid Antigravity tool call");
						const name = [...built.names].find(([, mapped]) => mapped === part.functionCall!.name)?.[0] ?? part.functionCall.name;
						const tool = context.tools?.find((entry) => entry.name === name);
						const needsPlaceholder = model.id.includes("claude") || model.id.includes("gemini-3-pro") || model.id.includes("gemini-3.1-pro");
						const args = tool ? restoreAntigravityToolArguments(part.functionCall.args ?? {}, tool.parameters, needsPlaceholder) : structuredClone(part.functionCall.args ?? {});
						// Parsed from the response JSON, so every value is already JSON.
						const call: ToolCall = { type: "toolCall", id: part.functionCall.id || `call_${randomUUID().replaceAll("-", "")}`, name, arguments: args as JsonObject, thoughtSignature: part.thoughtSignature };
						if (output.content.some((p) => p.type === "toolCall" && p.id === call.id)) throw new Error("Duplicate Antigravity tool call id");
						output.content.push(call); index = output.content.length - 1; visible = true;
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: output });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: output });
					}
				}
				const usage = record(body.usageMetadata) ? body.usageMetadata : record(body.usage_metadata) ? body.usage_metadata : undefined;
				if (usage) for (const [name, value] of Object.entries(usage)) if (typeof value === "number" && Number.isFinite(value) && value >= 0) numbers[name] = value;
				if (candidate?.finishReason) {
					terminal = true; output.rawStopReason = String(candidate.finishReason);
					if (candidate.finishReason === "STOP") output.stopReason = output.content.some((p) => p.type === "toolCall") ? "toolUse" : "stop";
					else if (candidate.finishReason === "MAX_TOKENS") output.stopReason = "length";
					else throw new Error(`Antigravity stopped with ${String(candidate.finishReason)}`);
				}
			}
			closeBlock();
			auth.signal.throwIfAborted();
			if (!terminal || !visible) throw new Error("Antigravity stream ended without a complete response");
			const prompt = (numbers.promptTokenCount ?? 0) + (numbers.toolUsePromptTokenCount ?? numbers.tool_use_prompt_token_count ?? 0);
			output.usage.input = Math.max(0, prompt - (numbers.cachedContentTokenCount ?? 0));
			output.usage.cacheRead = numbers.cachedContentTokenCount ?? 0;
			output.usage.output = (numbers.candidatesTokenCount ?? 0) + (numbers.thoughtsTokenCount ?? 0);
			output.usage.reasoning = numbers.thoughtsTokenCount ?? 0;
			output.usage.totalTokens = numbers.totalTokenCount || prompt + output.usage.output;
			if (output.stopReason === "pending") throw new Error("Missing Antigravity stop reason");
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		} catch (error) {
			delete output.antigravity;
			output.stopReason = options?.signal?.aborted || authSignal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : "Antigravity request failed";
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
			stream.end();
		}
	}
}
