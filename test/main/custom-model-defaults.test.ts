import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { customModelDefinition } from "../../src/main/custom-model-definition";
import type { RegistrationProfile } from "../../src/main/model-config-service";

function profile(overrides: Partial<RegistrationProfile> = {}): RegistrationProfile {
	return {
		providerId: "nekocode-fixture", name: "Proxy", sdkBaseUrl: "https://proxy.example/v1",
		api: "openai-responses", apiKey: "k", modelIds: ["gpt-test"], reasoning: false, imageInput: false,
		contextWindow: 256000, maxTokens: 32768, modelOverrides: {}, modelThinking: {}, ...overrides,
	};
}

const builtin = {
	id: "gpt-test", name: "GPT", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1",
	reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000,
	thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-responses">;

test("defaults use the built-in context window and thinking map", () => {
	const defined = customModelDefinition(profile(), "gpt-test", [builtin], () => ["off", "low", "medium", "high", "xhigh"]);
	expect(defined.contextWindow).toBe(1_000_000);
	expect(defined.maxTokens).toBe(128_000);
	expect(defined.reasoning).toBe(true);
	expect(defined.thinkingLevelMap).toEqual(builtin.thinkingLevelMap);
});

test("manual limits and thinking levels still win", () => {
	const defined = customModelDefinition(profile({
		modelOverrides: { "gpt-test": { contextWindow: 32000, maxTokens: 8000 } },
		modelThinking: { "gpt-test": ["off"] },
	}), "gpt-test", [builtin], () => ["off", "low", "high"]);
	expect(defined.contextWindow).toBe(32000);
	expect(defined.maxTokens).toBe(8000);
	expect(defined.reasoning).toBe(false);
});

test("unknown ids keep the provider default", () => {
	const defined = customModelDefinition(profile({ reasoning: true }), "custom-only", [builtin], () => ["off"]);
	expect(defined.contextWindow).toBe(256000);
	expect(defined.maxTokens).toBe(32768);
	expect(defined.reasoning).toBe(true);
	expect(defined.thinkingLevelMap).toMatchObject({ xhigh: null, max: null });
});

test("anthropic request flags still come from the built-in row", () => {
	const claude = {
		...builtin, id: "claude-test", api: "anthropic-messages", provider: "anthropic",
		compat: { forceAdaptiveThinking: true },
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	} as Model<"anthropic-messages">;
	const defined = customModelDefinition(
		profile({ api: "anthropic-messages", modelIds: ["claude-test"] }),
		"claude-test",
		[claude],
		() => ["low", "medium", "high", "xhigh", "max"],
	);
	expect(defined.contextWindow).toBe(1_000_000);
	expect(defined.compat).toEqual({ forceAdaptiveThinking: true });
	expect(defined.thinkingLevelMap?.off).toBeNull();
	expect(defined.thinkingLevelMap?.max).toBe("max");
});
