import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_CATALOG } from "./antigravity-catalog";
import { cleanAntigravityToolSchema } from "./antigravity-schema";
import { claudeSignature, geminiSignature, GEMINI_SIGNATURE_BYPASS } from "./antigravity-signatures";

export type Part = {
	text?: string; thought?: boolean; thoughtSignature?: string;
	functionCall?: { id?: string; name: string; args: Record<string, unknown> };
	functionResponse?: { id?: string; name: string; response: Record<string, unknown>; parts?: Part[] };
	inlineData?: { mimeType: string; data: string };
	[key: string]: unknown;
};
export type Content = { role: "user" | "model"; parts: Part[] };
export type AntigravityMessage = AssistantMessage & { antigravity?: { scope: string; model: string; parts: Part[] } };
export interface CatalogModel {
	id: string; name: string; contextWindow: number; maxTokens: number; input: readonly string[];
	thinking: { min: number; max: number; zero_allowed?: boolean; levels?: readonly string[]; dynamic_allowed?: boolean } | null;
}
export function catalogModel(id: string): CatalogModel {
	const model = ANTIGRAVITY_CATALOG.find((entry) => entry.id === id);
	if (!model) throw new Error(`Unknown Antigravity model: ${id}`);
	return model;
}
export function antigravityModels(): Model<"antigravity">[] {
	return ANTIGRAVITY_CATALOG.map((entry) => {
		const model: CatalogModel = entry;
		const levels = model.thinking?.levels;
		return {
			id: model.id, name: model.name, api: "antigravity", provider: "antigravity",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com", reasoning: !!model.thinking,
			input: model.input.filter((value): value is "text" | "image" => value === "text" || value === "image"),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
			...(levels ? { thinkingLevelMap: Object.fromEntries(["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, levels.includes(level) ? level : null])) } : {}),
		};
	});
}

function sanitizeName(name: string): string {
	let result = name.replace(/[^a-zA-Z0-9_.:-]/gu, "_");
	if (!/^[a-zA-Z_]/.test(result)) result = `_${result}`;
	return result.slice(0, 64);
}
/** Matches internal/util/translator.go: sorted, collision-safe names. */
export function functionNames(context: Context): Map<string, string> {
	const names = [...new Set([
		...(context.tools ?? []).map((tool) => tool.name),
		...context.messages.flatMap((message) => message.role === "toolResult" ? [message.toolName] : message.role === "assistant" ? message.content.filter((p) => p.type === "toolCall").map((p) => p.name) : []),
	])].filter(Boolean).sort();
	const counts = new Map<string, number>();
	for (const name of names) counts.set(sanitizeName(name), (counts.get(sanitizeName(name)) ?? 0) + 1);
	const used = new Set<string>();
	return new Map(names.map((name) => {
		const base = sanitizeName(name);
		let mapped = base;
		if (counts.get(base)! > 1 || used.has(base)) {
			for (let attempt = 0; ; attempt++) {
				mapped = `${base.slice(0, 51)}_${createHash("sha256").update(`${name}\0${attempt}`).digest("hex").slice(0, 12)}`;
				if (!used.has(mapped)) break;
			}
		}
		used.add(mapped); return [name, mapped];
	}));
}

function sanitizeParts(parts: Part[], claude: boolean, role: Content["role"]): Part[] {
	let seenCall = false;
	return parts.flatMap((original) => {
		const part = structuredClone(original);
		if (!claude && (part.toolCall || part.tool_call || part.toolResponse || part.tool_response)) return [part];
		const signature = part.thoughtSignature;
		delete part.thoughtSignature;
		if (role !== "model" || part.functionResponse) return [part];
		if (claude) {
			if (part.thought) {
				const valid = claudeSignature(signature);
				if (!valid || !part.text?.trim()) return [];
				part.thoughtSignature = valid;
			}
		} else {
			const valid = geminiSignature(signature);
			if (part.functionCall && !seenCall) part.thoughtSignature = valid ?? GEMINI_SIGNATURE_BYPASS;
			else if (valid) part.thoughtSignature = valid;
			if (part.functionCall) seenCall = true;
		}
		return [part];
	});
}

export function buildAntigravityRequest(modelId: string, context: Context, options: SimpleStreamOptions | undefined, project: string, scope: string) {
	const model = catalogModel(modelId);
	if (!project.trim()) throw new Error("Antigravity project ID is missing; sign in again");
	const claude = modelId.includes("claude");
	const names = functionNames(context);
	const contents: Content[] = [];
	const image = (value: { mimeType: string; data: string }): Part => {
		if (!model.input.includes("image")) throw new Error(`${model.name} does not support images`);
		return { inlineData: { mimeType: value.mimeType, data: value.data } };
	};
	for (const message of context.messages) {
		if (message.role === "user") {
			const parts = typeof message.content === "string" ? [{ text: message.content }] : message.content.map((p) => p.type === "text" ? { text: p.text } : image(p));
			if (parts.length) contents.push({ role: "user", parts });
		} else if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const replay = (message as AntigravityMessage).antigravity;
			let parts: Part[];
			if (message.provider === "antigravity" && message.model === modelId && replay?.model === modelId && replay.scope === scope) {
				parts = structuredClone(replay.parts);
			} else {
				// Foreign signatures and encrypted reasoning are never forwarded.
				parts = message.content.flatMap((p): Part[] => {
					if (p.type === "text") return p.text ? [{ text: p.text }] : [];
					if (p.type === "toolCall") return [{ functionCall: { id: p.id, name: p.name, args: p.arguments } }];
					return [];
				});
			}
			for (const part of parts) if (part.functionCall) {
				// Raw parts already contain the sanitized wire name for this tool set.
				part.functionCall.name = names.get(part.functionCall.name) ?? part.functionCall.name;
			}
			parts = sanitizeParts(parts, claude, "model");
			if (parts.length) contents.push({ role: "model", parts });
		} else if (message.role === "toolResult") {
			const text = message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
			const images = message.content.filter((p) => p.type === "image").map(image);
			const response: Part = { functionResponse: {
				id: message.toolCallId, name: names.get(message.toolName) ?? sanitizeName(message.toolName),
				response: message.isError ? { error: text || (images.length ? "(see attached image)" : "") } : { output: text || (images.length ? "(see attached image)" : "") },
				...(images.length ? { parts: images } : {}),
			} };
			const previous = contents.at(-1);
			if (previous?.role === "user" && previous.parts.some((p) => p.functionResponse)) previous.parts.push(response);
			else contents.push({ role: "user", parts: [response] });
		}
	}
	// Preserve native ids, including their absence, while pairing tool results.
	const calls = new Map<string, (string | undefined)[]>();
	for (const content of contents) for (const part of content.parts) {
		if (part.functionCall) {
			const queue = calls.get(part.functionCall.name) ?? []; queue.push(part.functionCall.id); calls.set(part.functionCall.name, queue);
		}
		if (part.functionResponse) {
			const queue = calls.get(part.functionResponse.name);
			if (!queue?.length) throw new Error(`Tool result has no matching call: ${part.functionResponse.name}`);
			const expected = queue.shift();
			if (expected) part.functionResponse.id = expected; else delete part.functionResponse.id;
		}
	}
	if (!contents.length) throw new Error("Antigravity requires a non-empty conversation");
	if (!claude) {
		if (contents[0]?.role === "model") contents.unshift({ role: "user", parts: [{ text: "" }] });
		if (contents.at(-1)?.role === "model") contents.push({ role: "user", parts: [{ text: "" }] });
	}
	const generationConfig: Record<string, unknown> = {};
	if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
	const maxTokens = Math.min(model.maxTokens, Math.max(1, options?.maxTokens ?? model.maxTokens));
	if (claude) generationConfig.maxOutputTokens = maxTokens;
	const requestedLevel = options?.reasoning ?? "off";
	const level = requestedLevel === "off" && model.thinking?.levels && !model.thinking.zero_allowed ? model.thinking.levels[0] : requestedLevel;
	if (model.thinking && level && level !== "off") {
		if (model.thinking.levels) {
			const chosen = model.thinking.levels.includes(level) ? level : level === "minimal" ? model.thinking.levels[0] : "high";
			generationConfig.thinkingConfig = { thinkingLevel: chosen, includeThoughts: requestedLevel !== "off" };
		} else {
			const budgets: Record<string, number> = { minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 128000 };
			const budget = budgets[level] ?? 8192;
			const normalized = Math.min(model.thinking.max, Math.max(model.thinking.min, budget), maxTokens - 1);
			if (normalized >= model.thinking.min) generationConfig.thinkingConfig = { thinkingBudget: normalized, includeThoughts: true };
		}
	}
	const requirePlaceholder = claude || modelId.includes("gemini-3-pro") || modelId.includes("gemini-3.1-pro");
	const declarations = [...new Map((context.tools ?? []).map((tool) => [tool.name, tool])).values()].map((tool) => ({ name: names.get(tool.name)!, description: tool.description, parameters: cleanAntigravityToolSchema(tool.parameters, requirePlaceholder) }));
	const firstText = contents.find((c) => c.role === "user" && c.parts[0]?.text)?.parts[0]?.text;
	const sessionId = firstText ? `-${createHash("sha256").update(firstText).digest().readBigUInt64BE(0) & 0x7fffffffffffffffn}` : `-${randomBytes(8).readBigUInt64BE(0) % 9_000_000_000_000_000_000n}`;
	const request = {
		contents, sessionId, generationConfig,
		...(context.systemPrompt ? { systemInstruction: { parts: [{ text: context.systemPrompt }] } } : {}),
		...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
		...(claude ? { toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } } : options?.toolChoice ? {
			toolConfig: { functionCallingConfig: {
				mode: options.toolChoice === "none" ? "NONE" : options.toolChoice === "auto" ? "AUTO" : "ANY",
			} },
		} : {}),
	};
	return { payload: { project, model: modelId, userAgent: "antigravity", requestType: "agent", requestId: `agent-${randomUUID()}`, request }, names };
}
