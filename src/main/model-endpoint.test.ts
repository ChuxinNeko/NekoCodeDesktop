import { describe, expect, test } from "bun:test";
import { resolveEndpoints } from "./model-endpoint";

describe("resolveEndpoints", () => {
	test("keeps /v1 out of the Anthropic SDK base URL", () => {
		// The Anthropic client appends /v1/messages itself, so a base URL still
		// ending in /v1 would make it request /v1/v1/messages.
		const { endpoint, sdkBaseUrl, modelsUrl } = resolveEndpoints(
			"https://example.com",
			"/v1/messages",
			"anthropic-messages",
		);
		expect(endpoint).toBe("https://example.com/v1/messages");
		expect(sdkBaseUrl).toBe("https://example.com");
		expect(modelsUrl).toBe("https://example.com/v1/models");
	});

	test("keeps a path prefix on the Anthropic SDK base URL", () => {
		const { sdkBaseUrl, modelsUrl } = resolveEndpoints(
			"https://example.com/anthropic",
			"/v1/messages",
			"anthropic-messages",
		);
		expect(sdkBaseUrl).toBe("https://example.com/anthropic");
		expect(modelsUrl).toBe("https://example.com/anthropic/v1/models");
	});

	test("falls back to the API root when the route omits /v1", () => {
		const { endpoint, sdkBaseUrl, modelsUrl } = resolveEndpoints(
			"https://example.com",
			"/messages",
			"anthropic-messages",
		);
		expect(endpoint).toBe("https://example.com/messages");
		expect(sdkBaseUrl).toBe("https://example.com");
		expect(modelsUrl).toBe("https://example.com/models");
	});

	test("leaves the OpenAI SDK base URL at the API root", () => {
		const completions = resolveEndpoints(
			"https://example.com",
			"/v1/chat/completions",
			"openai-completions",
		);
		expect(completions.sdkBaseUrl).toBe("https://example.com/v1");
		expect(completions.modelsUrl).toBe("https://example.com/v1/models");

		const responses = resolveEndpoints(
			"https://example.com",
			"/v1/responses",
			"openai-responses",
		);
		expect(responses.sdkBaseUrl).toBe("https://example.com/v1");
		expect(responses.modelsUrl).toBe("https://example.com/v1/models");
	});

	test("tolerates a trailing slash on the base URL", () => {
		const { endpoint, sdkBaseUrl } = resolveEndpoints(
			"https://example.com/",
			"/v1/messages",
			"anthropic-messages",
		);
		expect(endpoint).toBe("https://example.com/v1/messages");
		expect(sdkBaseUrl).toBe("https://example.com");
	});

	test("rejects a route that does not end with the protocol suffix", () => {
		expect(() =>
			resolveEndpoints("https://example.com", "/v1/chat", "anthropic-messages"),
		).toThrow(/must end with \/messages/);
	});
});
