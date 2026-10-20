import { expect, test } from "bun:test";
import { applyModelSettings } from "../../../src/renderer/src/lib/modelSettings";
import type { ModelProfileSummary } from "../../../src/shared/settings";

function profile(): ModelProfileSummary {
	return { id: "p", kind: "custom-api", name: "P", baseUrl: "https://example.test", route: "/v1/responses", api: "openai-responses",
		modelIds: ["a", "b", "c"], reasoning: true, imageInput: false, hasApiKey: true, createdAt: 1, updatedAt: 1,
		contextWindow: 256000, maxTokens: 32768,
		modelOverrides: { a: { contextWindow: 64000, maxTokens: 8000 }, c: { contextWindow: 32000, maxTokens: 4096 } },
		modelThinking: { a: ["high"], c: ["low"] },
		modelCapabilities: { b: { contextWindow: 128000, maxTokens: 16000, sources: { contextWindow: "endpoint", maxTokens: "endpoint" }, fetchedAt: 1 } },
	};
}

test("batch context edits retain each selected model's different output cap and unselected models", () => {
	const original = profile();
	const result = applyModelSettings(original, ["a", "b", "a", "unknown"], { limits: { contextWindow: 200000 } });
	expect(result.modelOverrides).toEqual({ a: { contextWindow: 200000, maxTokens: 8000 },
		b: { contextWindow: 200000, maxTokens: 16000 }, c: { contextWindow: 32000, maxTokens: 4096 } });
	expect(result.modelThinking).toEqual(original.modelThinking);
	expect(original.modelOverrides.a.contextWindow).toBe(64000);
});

test("batch output edits retain each model's effective context window", () => {
	const result = applyModelSettings(profile(), ["a", "b"], { limits: { maxTokens: 64000 } });
	expect(result.modelOverrides.a).toEqual({ contextWindow: 64000, maxTokens: 64000 });
	expect(result.modelOverrides.b).toEqual({ contextWindow: 128000, maxTokens: 64000 });
});

test("thinking-only edits leave token overrides alone and isolate copied level arrays", () => {
	const original = profile();
	const result = applyModelSettings(original, ["a", "b"], { thinking: ["max", "low"] });
	expect(result.modelOverrides).toEqual(original.modelOverrides);
	expect(result.modelThinking).toEqual({ a: ["low", "max"], b: ["low", "max"], c: ["low"] });
	result.modelThinking.a.push("high");
	expect(result.modelThinking.b).toEqual(["low", "max"]);
	expect(original.modelThinking.a).toEqual(["high"]);
});

test("batch reset clears only selected models' manual overrides", () => {
	const original = profile();
	const result = applyModelSettings(original, ["a", "b"], { limits: null, thinking: null });
	expect(result).toEqual({ modelOverrides: { c: original.modelOverrides.c }, modelThinking: { c: ["low"] } });
	expect(original.modelCapabilities?.b.maxTokens).toBe(16000);
});

test("empty changes and stale selections do not create overrides", () => {
	const original = profile();
	expect(applyModelSettings(original, ["b"], { limits: { maxTokens: undefined } })).toEqual({ modelOverrides: original.modelOverrides, modelThinking: original.modelThinking });
	expect(applyModelSettings(original, ["other-provider-model"], { thinking: ["high"] }).modelThinking).toEqual(original.modelThinking);
});

test("invalid batch limits and empty or unknown thinking sets are rejected before saving", () => {
	for (const value of [-1, 0, 2.5, 10000001]) expect(() => applyModelSettings(profile(), ["a"], { limits: { contextWindow: value } })).toThrow();
	for (const thinking of [[], ["unknown"]]) expect(() => applyModelSettings(profile(), ["a"], { thinking: thinking as never })).toThrow();
});
