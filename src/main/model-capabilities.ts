import type { Api, Model } from "@earendil-works/pi-ai";
import {
	MAX_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MIN_TOKEN_LIMIT, THINKING_LEVEL_ORDER,
	normalizeThinkingLevels, type FetchedModel, type ModelCapabilities,
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

/** Exact catalog IDs only; ambiguous catalogs contribute only values they agree on. */
export function fillCatalogCapabilities(
	models: FetchedModel[], catalog: readonly Model<Api>[],
	getLevels: (model: Model<Api>) => string[],
	fetchedAt = Date.now(),
): FetchedModel[] {
	const index = new Map<string, Model<Api>[]>();
	for (const model of catalog) {
		const entries = index.get(model.id) ?? [];
		entries.push(model);
		index.set(model.id, entries);
	}
	return models.map((entry) => {
		const matches = index.get(entry.id);
		if (!matches?.length) return entry;
		const detected: ModelCapabilities = structuredClone(entry.capabilities ?? { sources: {}, fetchedAt });
		for (const key of ["contextWindow", "maxTokens", "thinkingLevels"] as const) {
			if (detected[key] !== undefined) continue;
			const values = matches.map((model) => key === "thinkingLevels" ? normalizeThinkingLevels(getLevels(model)) : model[key]);
			if (!values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))) continue;
			if (key === "thinkingLevels") {
				const levels = normalizeThinkingLevels(values[0]);
				if (!levels) continue;
				detected.thinkingLevels = levels;
			} else {
				const value = limit(values[0], key === "contextWindow" ? MAX_CONTEXT_WINDOW : MAX_OUTPUT_TOKENS);
				if (value === undefined) continue;
				detected[key] = value;
			}
			detected.sources[key] = "catalog";
		}
		const anthropic = matches.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages");
		const modes = anthropic.map((model) => ({ adaptive: model.compat?.forceAdaptiveThinking === true, disabled: model.thinkingLevelMap?.off !== null }));
		if (!detected.anthropicThinking && modes.length && modes.every((mode) => JSON.stringify(mode) === JSON.stringify(modes[0]))) {
			detected.anthropicThinking = modes[0];
			detected.sources.anthropicThinking = "catalog";
		}
		return Object.keys(detected.sources).length ? { ...entry, capabilities: detected } : entry;
	});
}
