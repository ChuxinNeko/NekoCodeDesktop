import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, normalizeContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { customModelDefinition } from "../../src/main/custom-model-definition";
import { parseModelCapabilities } from "../../src/main/model-capabilities";
import type { RegistrationProfile } from "../../src/main/model-config-service";
import type { ThinkingLevel } from "../../src/shared/agent";

const catalog = getBuiltinModels("anthropic");
function profile(id: string): RegistrationProfile {
	return { providerId: "nekocode-fixture", name: "Custom Claude", sdkBaseUrl: "https://fixture.invalid", api: "anthropic-messages",
		apiKey: "fixture-key", modelIds: [id], reasoning: true, imageInput: false, contextWindow: 200000, maxTokens: 32000,
		modelOverrides: {}, modelThinking: {} };
}

/** Capture the actual SDK payload, then fail locally before transport. */
async function payload(id: string, reasoning?: Exclude<ThinkingLevel, "off">, changes: Partial<RegistrationProfile> = {}) {
	const config = { ...profile(id), ...changes };
	const definition = customModelDefinition(config, id, catalog, getSupportedThinkingLevels);
	const model = { ...definition, provider: config.providerId, baseUrl: config.sdkBaseUrl } as Model<"anthropic-messages">;
	let captured: Record<string, any> | undefined;
	let requests = 0;
	const result = await streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }), {
		apiKey: "fixture-key", reasoning, maxTokens: 4096,
		onPayload: (body) => { captured = body as Record<string, any>; throw new Error("payload captured; no network"); },
		fetch: Object.assign(async () => { requests++; throw new Error("unexpected transport"); }, { preconnect: () => {} }),
	}).result();
	expect(result.errorMessage).toContain("payload captured");
	expect(requests).toBe(0);
	expect(captured).toBeDefined();
	return captured!;
}

test("existing custom Opus 5.5 profiles inherit adaptive thinking without refetching", async () => {
	const body = await payload("claude-opus-5-5", "high");
	expect(body.thinking.type).toBe("adaptive");
	expect(body.thinking.budget_tokens).toBeUndefined();
	expect(body.output_config.effort).toBe("high");
});

test("the model test omits unsupported disabled thinking on Opus 5.5", async () => {
	expect((await payload("claude-opus-5-5")).thinking).toBeUndefined();
	const model = customModelDefinition(profile("claude-opus-5-5"), "claude-opus-5-5", catalog, getSupportedThinkingLevels);
	expect(getSupportedThinkingLevels(model as Model<"anthropic-messages">)).not.toContain("off");
});

test("a manually non-reasoning profile still works with an adaptive-only model", async () => {
	const body = await payload("claude-opus-5-5", undefined, { reasoning: false, modelThinking: { "claude-opus-5-5": ["off"] } });
	expect(body.thinking).toBeUndefined();
});

test("older Claude models keep budget-based thinking", async () => {
	const body = await payload("claude-sonnet-4-5", "high");
	expect(body.thinking.type).toBe("enabled");
	expect(body.thinking.budget_tokens).toBeGreaterThan(0);
	expect(body.output_config).toBeUndefined();
});

test("adaptive models that allow off retain disabled-thinking requests", async () => {
	const body = await payload("claude-opus-4-6");
	expect(body.thinking).toEqual({ type: "disabled" });
});

test("endpoint metadata handles adaptive models absent from the built-in catalog", async () => {
	const id = "fixture-adaptive-model";
	const capabilities = parseModelCapabilities({ capabilities: {
		thinking: { supported: true, types: { adaptive: { supported: true }, disabled: { supported: false } } },
		effort: { supported: true, low: { supported: true }, high: { supported: true } },
	} })!;
	const changes = { modelCapabilities: { [id]: capabilities } };
	expect((await payload(id, "high", changes)).thinking.type).toBe("adaptive");
	expect((await payload(id, undefined, changes)).thinking).toBeUndefined();
});

test("per-model max effort is forwarded for custom adaptive models", async () => {
	const body = await payload("claude-opus-5-5", "max", { modelThinking: { "claude-opus-5-5": ["high", "max"] } });
	expect(body.thinking.type).toBe("adaptive");
	expect(body.output_config.effort).toBe("max");
});
