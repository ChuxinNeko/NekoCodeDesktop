import { describe, expect, test } from "bun:test";
import {
	buildModelsHeaders,
	joinEndpoint,
	parseModelsJson,
	resolveEndpoints,
} from "./model-endpoint";

describe("resolveEndpoints", () => {
	test("openai-completions derives sdkBaseUrl and models URL", () => {
		expect(
			resolveEndpoints(
				"https://api.openai.com",
				"/v1/chat/completions",
				"openai-completions",
			),
		).toEqual({
			endpoint: "https://api.openai.com/v1/chat/completions",
			sdkBaseUrl: "https://api.openai.com/v1",
			modelsUrl: "https://api.openai.com/v1/models",
		});
	});

	test("openai-responses and anthropic-messages suffixes", () => {
		expect(
			resolveEndpoints(
				"https://gw.example.com/api",
				"/v1/responses",
				"openai-responses",
			).modelsUrl,
		).toBe("https://gw.example.com/api/v1/models");
		expect(
			resolveEndpoints(
				"https://api.anthropic.com",
				"/v1/messages",
				"anthropic-messages",
			),
		).toEqual({
			endpoint: "https://api.anthropic.com/v1/messages",
			sdkBaseUrl: "https://api.anthropic.com/v1",
			modelsUrl: "https://api.anthropic.com/v1/models",
		});
	});

	test("tolerates trailing slash on base", () => {
		expect(
			resolveEndpoints(
				"https://api.openai.com/",
				"/v1/chat/completions",
				"openai-completions",
			).sdkBaseUrl,
		).toBe("https://api.openai.com/v1");
	});

	test("rejects non-http schemes, credentials, query, and ..", () => {
		expect(() =>
			resolveEndpoints("ftp://x.com", "/v1/messages", "anthropic-messages"),
		).toThrow("http or https");
		expect(() =>
			resolveEndpoints(
				"https://user:pass@x.com",
				"/v1/messages",
				"anthropic-messages",
			),
		).toThrow("credentials");
		expect(() =>
			resolveEndpoints(
				"https://x.com",
				"/v1/messages?key=1",
				"anthropic-messages",
			),
		).toThrow("query or hash");
		expect(() =>
			resolveEndpoints(
				"https://x.com",
				"/v1/../messages",
				"anthropic-messages",
			),
		).toThrow("..");
	});

	test("rejects base URL query/hash and control characters", () => {
		expect(() =>
			resolveEndpoints(
				"https://x.com/?token=1",
				"/v1/messages",
				"anthropic-messages",
			),
		).toThrow("query or hash");
		expect(() =>
			resolveEndpoints(
				"https://x.com/#frag",
				"/v1/messages",
				"anthropic-messages",
			),
		).toThrow("query or hash");
		expect(() =>
			resolveEndpoints(
				"https://x.c\x01om",
				"/v1/messages",
				"anthropic-messages",
			),
		).toThrow("control");
	});

	test("rejects route backslash, control chars, and encoded traversal", () => {
		expect(() =>
			resolveEndpoints("https://x.com", "/v1\\messages", "anthropic-messages"),
		).toThrow("invalid characters");
		expect(() =>
			resolveEndpoints(
				"https://x.com",
				"/v1/%2e%2e/messages",
				"anthropic-messages",
			),
		).toThrow("..");
		expect(() =>
			resolveEndpoints(
				"https://x.com",
				"/v1/%zz/messages",
				"anthropic-messages",
			),
		).toThrow("invalid encoding");
	});

	test("rejects route not starting with / and wrong protocol suffix", () => {
		expect(() =>
			resolveEndpoints(
				"https://x.com",
				"v1/messages",
				"anthropic-messages",
			),
		).toThrow("start with /");
		expect(() =>
			resolveEndpoints(
				"https://x.com",
				"/v1/chat/completions",
				"anthropic-messages",
			),
		).toThrow("/messages");
		expect(() =>
			resolveEndpoints(
				"https://x.com",
				"/v1/messages",
				"openai-completions",
			),
		).toThrow("/chat/completions");
	});
});

describe("joinEndpoint", () => {
	test("merges slashes on both sides", () => {
		expect(joinEndpoint("https://a.com/", "/v1")).toBe("https://a.com/v1");
		expect(joinEndpoint("https://a.com", "v1")).toBe("https://a.com/v1");
	});
});

describe("buildModelsHeaders", () => {
	test("OpenAI protocols use Bearer auth", () => {
		expect(buildModelsHeaders("openai-completions", "k1")).toEqual({
			Accept: "application/json",
			Authorization: "Bearer k1",
		});
		expect(buildModelsHeaders("openai-responses", "k1")).toEqual({
			Accept: "application/json",
			Authorization: "Bearer k1",
		});
	});

	test("Anthropic uses x-api-key + version", () => {
		expect(buildModelsHeaders("anthropic-messages", "k2")).toEqual({
			Accept: "application/json",
			"x-api-key": "k2",
			"anthropic-version": "2023-06-01",
		});
	});
});

describe("parseModelsJson", () => {
	test("parses OpenAI data array", () => {
		const models = parseModelsJson({
			data: [
				{ id: "gpt-4o", object: "model" },
				{ id: "gpt-4o-mini" },
			],
		});
		expect(models).toEqual([
			{ id: "gpt-4o", name: "gpt-4o" },
			{ id: "gpt-4o-mini", name: "gpt-4o-mini" },
		]);
	});

	test("parses Anthropic display_name, dedupes and sorts", () => {
		const models = parseModelsJson({
			data: [
				{ id: "claude-b", display_name: "Claude B" },
				{ id: "claude-a" },
				{ id: "claude-b" },
				{ id: "" },
				{ id: 42 },
			],
		});
		expect(models).toEqual([
			{ id: "claude-a", name: "claude-a" },
			{ id: "claude-b", name: "Claude B" },
		]);
	});

	test("accepts top-level models array", () => {
		expect(parseModelsJson({ models: [{ id: "m1" }] })).toEqual([
			{ id: "m1", name: "m1" },
		]);
	});

	test("rejects non-object and missing list shapes", () => {
		expect(() => parseModelsJson([])).toThrow("shape");
		expect(() => parseModelsJson("data")).toThrow("shape");
		expect(() => parseModelsJson({ items: [] })).toThrow("shape");
	});
});
