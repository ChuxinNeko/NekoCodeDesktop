import type { Api, Model } from "@earendil-works/pi-ai";
import {
	MAX_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MIN_TOKEN_LIMIT, THINKING_LEVEL_ORDER,
	normalizeThinkingLevels, type FetchedModel, type ModelApiProtocol, type ModelCapabilities,
} from "../shared/settings";

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

function limit(value: unknown, max: number): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= MIN_TOKEN_LIMIT && value <= max
		? value : undefined;
}

/** Accept metadata only, never infer capabilities from a model's name. */
export function parseModelCapabilities(raw: unknown, fetchedAt = Date.now()): ModelCapabilities | undefined {
	const entry = object(raw);
	const top = object(entry.top_provider);
	const capabilities = object(entry.capabilities);
	const thinking = object(capabilities.thinking);
	const effort = object(capabilities.effort);
	const types = object(thinking.types);
	const result: ModelCapabilities = { sources: {}, fetchedAt };
	if (typeof object(types.adaptive).supported === "boolean") {
		result.anthropicThinking = { adaptive: object(types.adaptive).supported as boolean };
		if (typeof object(types.disabled).supported === "boolean") result.anthropicThinking.disabled = object(types.disabled).supported as boolean;
	}
	result.contextWindow = [entry.context_length, entry.contextWindow, entry.max_input_tokens]
		.map((value) => limit(value, MAX_CONTEXT_WINDOW)).find((value) => value !== undefined);
	result.maxTokens = [top.max_completion_tokens, entry.max_output_tokens, entry.maxTokens, entry.max_tokens]
		.map((value) => limit(value, MAX_OUTPUT_TOKENS)).find((value) => value !== undefined);
	const explicit = normalizeThinkingLevels(entry.thinking_levels ?? entry.supported_thinking_levels);
	if (explicit) result.thinkingLevels = explicit;
	else if (thinking.supported === false || entry.reasoning === false) result.thinkingLevels = ["off"];
	else if (thinking.supported === true && object(types.adaptive).supported === true && effort.supported === true) {
		const levels = THINKING_LEVEL_ORDER.filter((level) => level === "off"
			? object(types.disabled).supported === true
			: object(effort[level]).supported === true);
		if (levels.length) result.thinkingLevels = levels;
	}
	for (const key of ["contextWindow", "maxTokens", "thinkingLevels", "anthropicThinking"] as const) {
		if (result[key] === undefined) delete result[key];
		else result.sources[key] = "endpoint";
	}
	return Object.keys(result.sources).length ? result : undefined;
}

/** Official hosts whose built-in provider is unambiguous. */
export function preferredBuiltinProvider(baseUrl: string): string | undefined {
	try {
		const host = new URL(baseUrl).hostname;
		if (host === "api.openai.com") return "openai";
		if (host === "api.anthropic.com") return "anthropic";
		if (host === "openrouter.ai") return "openrouter";
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * Origin providers for a protocol, aggregators last. The first one that actually
 * lists the model id wins, so a proxy of `claude-opus-4-6` uses Anthropic's row
 * instead of waiting for every copy of that id to agree.
 */
const CANONICAL_PROVIDERS: Record<ModelApiProtocol, readonly string[]> = {
	"anthropic-messages": ["anthropic"],
	"openai-responses": ["openai", "openai-codex", "azure"],
	"openai-completions": [
		"openai", "deepseek", "groq", "mistral", "google", "xai", "together",
		"moonshotai", "moonshotai-cn", "minimax", "minimax-cn", "zai", "zai-coding-cn",
		"cerebras", "fireworks", "nvidia", "huggingface", "kimi-coding", "openrouter",
	],
};

export interface CatalogPreference {
	api?: ModelApiProtocol;
	provider?: string;
}

/** Exact id only. Custom registrations are not a reference for themselves. */
export function selectCatalogModels<T extends { id: string; provider: string; api: string }>(
	catalog: readonly T[],
	id: string,
	preference: CatalogPreference = {},
): T[] {
	let matches = catalog.filter((model) => model.id === id && !model.provider?.startsWith("nekocode-"));
	if (!matches.length) return [];
	if (preference.provider) {
		const preferred = matches.filter((model) => model.provider === preference.provider);
		if (preferred.length) matches = preferred;
	}
	if (!preference.api) return matches;
	const sameApi = matches.filter((model) => model.api === preference.api);
	const pool = sameApi.length ? sameApi : matches;
	for (const name of CANONICAL_PROVIDERS[preference.api]) {
		const hit = pool.filter((model) => model.provider === name);
		if (hit.length) return hit;
	}
	return pool;
}

/**
 * Levels every selected row supports. A full-set mismatch no longer drops `max`
 * when each row lists it; levels only some rows support stay out.
 */
function sharedThinkingLevels(sets: readonly (readonly string[] | null)[]): ReturnType<typeof normalizeThinkingLevels> {
	if (!sets.length || sets.some((levels) => !levels?.length)) return null;
	const shared = THINKING_LEVEL_ORDER.filter((level) => sets.every((levels) => levels!.includes(level)));
	return shared.length ? shared : null;
}

/** Fields the selected catalog rows agree on. One row contributes all of its fields. */
export function capabilitiesFromMatches(
	matches: readonly Model<Api>[],
	getLevels: (model: Model<Api>) => string[],
	fetchedAt = Date.now(),
): ModelCapabilities | undefined {
	if (!matches.length) return undefined;
	const detected: ModelCapabilities = { sources: {}, fetchedAt };
	for (const key of ["contextWindow", "maxTokens"] as const) {
		const values = matches.map((model) => model[key]);
		if (!values.every((value) => value === values[0])) continue;
		const value = limit(values[0], key === "contextWindow" ? MAX_CONTEXT_WINDOW : MAX_OUTPUT_TOKENS);
		if (value === undefined) continue;
		detected[key] = value;
		detected.sources[key] = "catalog";
	}
	const sharedLevels = sharedThinkingLevels(matches.map((model) => normalizeThinkingLevels(getLevels(model))));
	if (sharedLevels) {
		detected.thinkingLevels = sharedLevels;
		detected.sources.thinkingLevels = "catalog";
	}
	const anthropic = matches.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages");
	const modes = anthropic.map((model) => ({ adaptive: model.compat?.forceAdaptiveThinking === true, disabled: model.thinkingLevelMap?.off !== null }));
	if (modes.length && modes.every((mode) => JSON.stringify(mode) === JSON.stringify(modes[0]))) {
		detected.anthropicThinking = modes[0];
		detected.sources.anthropicThinking = "catalog";
	}
	return Object.keys(detected.sources).length ? detected : undefined;
}

/**
 * Built-in catalog wins over endpoint metadata for each field it actually has.
 * Endpoint values remain for models the catalog does not list.
 */
export function preferCatalogCapabilities(
	stored: ModelCapabilities | undefined,
	builtin: ModelCapabilities | undefined,
): ModelCapabilities | undefined {
	if (!builtin) return stored;
	if (!stored) return builtin;
	const merged: ModelCapabilities = { ...stored, sources: { ...stored.sources }, fetchedAt: stored.fetchedAt };
	if (builtin.contextWindow !== undefined) {
		merged.contextWindow = builtin.contextWindow;
		merged.sources.contextWindow = "catalog";
	}
	if (builtin.maxTokens !== undefined) {
		merged.maxTokens = builtin.maxTokens;
		merged.sources.maxTokens = "catalog";
	}
	if (builtin.thinkingLevels) {
		merged.thinkingLevels = [...builtin.thinkingLevels];
		merged.sources.thinkingLevels = "catalog";
	}
	if (builtin.anthropicThinking) {
		merged.anthropicThinking = { ...builtin.anthropicThinking };
		merged.sources.anthropicThinking = "catalog";
	}
	return merged;
}

/** Apply pi's built-in context and thinking levels. Returns the stored record unchanged when nothing matches. */
export function overlayBuiltinCapabilities(
	summary: { api: ModelApiProtocol; baseUrl: string; modelIds: readonly string[]; modelCapabilities?: Record<string, ModelCapabilities> },
	catalog: readonly Model<Api>[],
	getLevels: (model: Model<Api>) => string[],
	fetchedAt = Date.now(),
): Record<string, ModelCapabilities> | undefined {
	const provider = preferredBuiltinProvider(summary.baseUrl);
	let capabilities = summary.modelCapabilities;
	for (const id of summary.modelIds) {
		const builtin = capabilitiesFromMatches(
			selectCatalogModels(catalog, id, { api: summary.api, provider }),
			getLevels,
			fetchedAt,
		);
		const merged = preferCatalogCapabilities(capabilities?.[id], builtin);
		if (!merged || merged === capabilities?.[id]) continue;
		capabilities = { ...capabilities, [id]: merged };
	}
	return capabilities;
}

/** Exact catalog IDs only. Pi's built-in row wins over endpoint metadata. */
export function fillCatalogCapabilities(
	models: FetchedModel[], catalog: readonly Model<Api>[],
	getLevels: (model: Model<Api>) => string[],
	fetchedAt = Date.now(),
	preference: CatalogPreference = {},
): FetchedModel[] {
	return models.map((entry) => {
		const builtin = capabilitiesFromMatches(selectCatalogModels(catalog, entry.id, preference), getLevels, fetchedAt);
		const capabilities = preferCatalogCapabilities(entry.capabilities, builtin);
		return capabilities ? { ...entry, capabilities } : entry;
	});
}
