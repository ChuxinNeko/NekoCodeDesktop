import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { parseModelsJson } from "../../src/main/model-endpoint";
import {
	capabilitiesFromMatches, fillCatalogCapabilities, overlayBuiltinCapabilities, parseModelCapabilities, selectCatalogModels,
} from "../../src/main/model-capabilities";
import { effectiveModelLimits, effectiveThinkingLevels, type ModelProfileSummary } from "../../src/shared/settings";
import { thinkingRegistration, toSummary, validateProfileFile } from "../../src/main/model-config-store";

describe("endpoint capability discovery", () => {
	test("retains OpenRouter limits without inventing effort levels from supported_parameters", () => {
		const [model] = parseModelsJson({ data: [{ id: "vendor/model", context_length: 200000,
			top_provider: { max_completion_tokens: 64000 }, supported_parameters: ["reasoning", "reasoning_effort"] }] });
		expect(model.capabilities).toMatchObject({ contextWindow: 200000, maxTokens: 64000,
			sources: { contextWindow: "endpoint", maxTokens: "endpoint" } });
		expect(model.capabilities?.thinkingLevels).toBeUndefined();
	});
	test("reads Claude native effort capability and disabled-thinking support independently", () => {
		expect(parseModelCapabilities({ max_input_tokens: 1000000, max_tokens: 128000, capabilities: {
			thinking: { supported: true, types: { adaptive: { supported: true }, disabled: { supported: false } } },
			effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: true }, xhigh: { supported: false } },
		} }, 1)).toEqual({ contextWindow: 1000000, maxTokens: 128000, thinkingLevels: ["low", "medium", "high", "max"],
			anthropicThinking: { adaptive: true, disabled: false },
			sources: { contextWindow: "endpoint", maxTokens: "endpoint", thinkingLevels: "endpoint", anthropicThinking: "endpoint" }, fetchedAt: 1 });
	});
	test("does not turn a thinking boolean into an exact effort list", () => {
		expect(parseModelCapabilities({ capabilities: { thinking: { supported: true } } })).toBeUndefined();
		expect(parseModelCapabilities({ capabilities: { thinking: { supported: false } } })?.thinkingLevels).toEqual(["off"]);
	});
	test("accepts explicit known effort sets, rejects invalid values and does not guess from names", () => {
		expect(parseModelCapabilities({ thinking_levels: ["max", "low", "low"] }, 1)?.thinkingLevels).toEqual(["low", "max"]);
		for (const value of [-1, 0, 1.5, Infinity, "128000", 999999999]) {
			expect(parseModelCapabilities({ context_length: value, max_tokens: value })).toBeUndefined();
		}
		expect(parseModelCapabilities({ id: "gpt-anything-high", thinking_levels: ["unknown"] })).toBeUndefined();
	});
	test("plain model lists remain compatible and deduplicated", () => {
		expect(parseModelsJson({ models: [{ id: "m", display_name: "Model" }, { id: "m" }] })).toEqual([{ id: "m", name: "Model" }]);
	});
});

const model = (overrides = {}): Model<Api> => ({ id: "m", contextWindow: 100000, maxTokens: 16000,
	reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", high: "high", medium: null, xhigh: null, max: "max" }, ...overrides }) as Model<Api>;

describe("catalog fallback and precedence", () => {
	test("prefers the built-in context and thinking levels over endpoint values for the same id", () => {
		const result = fillCatalogCapabilities([{ id: "m", name: "M", capabilities: parseModelCapabilities({ context_length: 64000 }, 1) },
			{ id: "m-alias", name: "M" }], [model()], getSupportedThinkingLevels, 1);
		expect(result[0].capabilities).toEqual({ contextWindow: 100000, maxTokens: 16000, thinkingLevels: ["low", "high", "max"],
			sources: { contextWindow: "catalog", maxTokens: "catalog", thinkingLevels: "catalog" }, fetchedAt: 1 });
		expect(result[1].capabilities).toBeUndefined();
	});
	test("keeps endpoint values when the built-in catalog has no row", () => {
		const [result] = fillCatalogCapabilities([{ id: "proxy-only", name: "P", capabilities: parseModelCapabilities({ context_length: 64000, max_tokens: 8000 }, 1) }],
			[model()], getSupportedThinkingLevels, 1);
		expect(result.capabilities).toMatchObject({ contextWindow: 64000, maxTokens: 8000, sources: { contextWindow: "endpoint", maxTokens: "endpoint" } });
	});
	test("uses the origin provider when the same id disagrees across catalogs", () => {
		const anthropic = model({ provider: "anthropic", api: "anthropic-messages", contextWindow: 200000, maxTokens: 32000 });
		const bedrock = model({ provider: "amazon-bedrock", api: "bedrock-converse-stream", contextWindow: 100000, maxTokens: 8000 });
		const [selected] = selectCatalogModels([bedrock, anthropic], "m", { api: "anthropic-messages" });
		expect(selected.provider).toBe("anthropic");
		expect(capabilitiesFromMatches([selected], getSupportedThinkingLevels, 1)).toMatchObject({ contextWindow: 200000, maxTokens: 32000 });
		const overlaid = overlayBuiltinCapabilities({
			api: "anthropic-messages", baseUrl: "https://proxy.example/v1", modelIds: ["m"],
			modelCapabilities: { m: parseModelCapabilities({ context_length: 64000 }, 4)! },
		}, [bedrock, anthropic], getSupportedThinkingLevels, 1);
		expect(overlaid?.m).toMatchObject({ contextWindow: 200000, maxTokens: 32000, sources: { contextWindow: "catalog", maxTokens: "catalog" }, fetchedAt: 4 });
	});
	test("keeps thinking levels every catalog row supports, including max", () => {
		const opencode = model({ provider: "opencode", api: "openai-completions", contextWindow: 1_000_000, maxTokens: 384000 });
		const qwen = model({ provider: "qwen-token-plan", api: "openai-completions", contextWindow: 1_000_000, maxTokens: 384000 });
		const levels = (entry: Model<Api>) => entry.provider === "opencode" ? ["off", "high", "max"] : ["low", "high", "max"];
		const [result] = fillCatalogCapabilities([{ id: "m", name: "M" }], [opencode, qwen], levels, 1, { api: "openai-completions" });
		expect(result.capabilities?.thinkingLevels).toEqual(["high", "max"]);
		expect(result.capabilities?.contextWindow).toBe(1_000_000);
		expect(result.capabilities?.maxTokens).toBe(384000);
		expect(getSupportedThinkingLevels(thinkingRegistration(result.capabilities!.thinkingLevels, false) as never)).toEqual(["high", "max"]);
	});
	test("does not pick arbitrary limits from ambiguous catalog models", () => {
		const [result] = fillCatalogCapabilities([{ id: "m", name: "M" }], [model(), model({ maxTokens: 32000 })], getSupportedThinkingLevels, 1);
		expect(result.capabilities?.contextWindow).toBe(100000);
		expect(result.capabilities?.maxTokens).toBeUndefined();
	});
	test("manual > discovered > provider defaults, including reset behavior and runtime thinking", () => {
		const profile: ModelProfileSummary = { id: "p", name: "P", kind: "custom-api", baseUrl: "https://example.test", route: "/v1/responses", api: "openai-responses",
			modelIds: ["m"], imageInput: false, hasApiKey: true, createdAt: 1, updatedAt: 1,
			contextWindow: 256000, maxTokens: 32768, reasoning: false, modelOverrides: {}, modelThinking: {},
			modelCapabilities: { m: parseModelCapabilities({ context_length: 64000, thinking_levels: ["low", "max"] }, 1)! } };
		expect(effectiveModelLimits(profile, "m")).toEqual({ contextWindow: 64000, maxTokens: 32768 });
		expect(effectiveThinkingLevels(profile, "m")).toEqual(["low", "max"]);
		expect(getSupportedThinkingLevels(thinkingRegistration(effectiveThinkingLevels(profile, "m"), false) as never)).toEqual(["low", "max"]);
		profile.modelThinking.m = ["off"];
		profile.modelOverrides.m = { contextWindow: 32000, maxTokens: 8000 };
		expect(effectiveModelLimits(profile, "m")).toEqual({ contextWindow: 32000, maxTokens: 8000 });
		expect(effectiveThinkingLevels(profile, "m")).toEqual(["off"]);
		delete profile.modelThinking.m;
		delete profile.modelOverrides.m;
		expect(effectiveThinkingLevels(profile, "m")).toEqual(["low", "max"]);
	});
	test("metadata survives storage validation, with isolated summary copies", () => {
		const stored = { id: "p", name: "P", baseUrl: "https://example.test", route: "/v1/responses", api: "openai-responses",
			encryptedApiKey: "x", modelIds: ["m"], createdAt: 1, updatedAt: 1,
			modelCapabilities: { m: parseModelCapabilities({ max_tokens: 16000 }, 1)! } };
		const [validated] = validateProfileFile({ version: 1, profiles: [stored] });
		const summary = toSummary(validated);
		expect(summary.modelCapabilities).toEqual(stored.modelCapabilities);
		summary.modelCapabilities!.m.maxTokens = 32000;
		expect(stored.modelCapabilities.m.maxTokens).toBe(16000);
		for (const patch of [{ maxTokens: -1 }, { sources: { maxTokens: "guess" } }, { fetchedAt: "yesterday" }]) {
			expect(() => validateProfileFile({ version: 1, profiles: [{ ...stored,
				modelCapabilities: { m: { ...stored.modelCapabilities.m, ...patch } } }] })).toThrow();
		}
	});
});
