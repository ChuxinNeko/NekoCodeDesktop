// This fixture runs in its own process so the Electron mock cannot affect other tests.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "neko-capabilities-"));
mock.module("electron", () => ({ app: { getPath: () => dir }, safeStorage: {
	isEncryptionAvailable: () => true,
	encryptString: (value: string) => Buffer.from(value),
	decryptString: (value: Buffer) => value.toString(),
} }));
const { ModelConfigService } = await import("../../../src/main/model-config-service");
const { effectiveModelLimits, effectiveThinkingLevels } = await import("../../../src/shared/settings");
try {
	const service = new ModelConfigService();
	let profile = service.save({ name: "Test", baseUrl: "https://api.openai.com", route: "/v1/responses",
		api: "openai-responses", apiKey: "fixture-key", modelIds: ["fixture-one"], reasoning: false,
		modelThinking: { "fixture-one": ["off"] }, modelOverrides: { "fixture-one": { contextWindow: 32000, maxTokens: 8000 } } });
	const request = () => ({ profileId: profile.id, baseUrl: profile.baseUrl, route: profile.route, api: profile.api });
	let payload = { data: [{ id: "fixture-one", context_length: 128000, max_tokens: 64000, thinking_levels: ["low", "high"] },
		{ id: "fixture-two", context_length: 96000, max_tokens: 16000, thinking_levels: ["low", "max"] }, { id: "gpt-4.1" }] };
	globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
		assert.equal(String(url), "https://api.openai.com/v1/models");
		assert.equal(options?.method, "GET");
		assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer fixture-key");
		return Response.json(payload);
	}) as typeof fetch;
	const result = await service.fetchModels(request());
	assert.equal(result.find((model) => model.id === "gpt-4.1")?.capabilities?.sources.contextWindow, "catalog");
	profile = service.list()[0];
	assert.equal(profile.modelCapabilities?.["fixture-one"].contextWindow, 128000);
	assert.equal(effectiveModelLimits(profile, "fixture-one").contextWindow, 32000);
	assert.deepEqual(effectiveThinkingLevels(profile, "fixture-one"), ["off"]);
	// Adding a fetched model persists its discovered data without copying it into manual overrides.
	profile = service.save({ ...profile, modelIds: [...profile.modelIds, "fixture-two"] });
	assert.deepEqual(effectiveThinkingLevels(profile, "fixture-two"), ["low", "max"]);
	assert.equal(profile.modelOverrides["fixture-two"], undefined);
	profile = service.save({ ...profile, modelOverrides: {}, modelThinking: {} });
	assert.equal(effectiveModelLimits(profile, "fixture-one").maxTokens, 64000);
	assert.deepEqual(effectiveThinkingLevels(profile, "fixture-one"), ["low", "high"]);
	assert.deepEqual(new ModelConfigService().list()[0].modelCapabilities, profile.modelCapabilities);
	// A fresh discovery replaces previous automatic data; it never creates manual entries.
	payload = { data: [{ id: "fixture-one", context_length: 200000, max_tokens: 32000, thinking_levels: ["high"] }] };
	await service.fetchModels(request());
	profile = service.list()[0];
	assert.equal(effectiveModelLimits(profile, "fixture-one").contextWindow, 200000);
	assert.deepEqual(effectiveThinkingLevels(profile, "fixture-one"), ["high"]);
	const previous = structuredClone(profile.modelCapabilities);
	globalThis.fetch = (async () => new Response("failure", { status: 503 })) as unknown as typeof fetch;
	await assert.rejects(service.fetchModels(request()), /HTTP 503/);
	assert.deepEqual(service.list()[0].modelCapabilities, previous);
	// An in-flight request for an old endpoint must not repopulate the new endpoint's cache.
	let resolveFetch!: (response: Response) => void;
	globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as unknown as typeof fetch;
	const pending = service.fetchModels(request());
	profile = service.save({ ...profile, baseUrl: "https://different.example" });
	resolveFetch(Response.json(payload));
	await pending;
	assert.deepEqual(service.list()[0].modelCapabilities, {});
	profile = service.save({ ...profile, modelIds: ["fixture-one"] });
	assert.deepEqual(profile.modelCapabilities, {});
	console.log("model capability service integration passed");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
