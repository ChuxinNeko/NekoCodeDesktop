import { describe, expect, test } from "bun:test";
import { PROTOCOL_DEFAULT_ROUTE, parseFullEndpoint, protocolForRoute } from "./model-protocol";

describe("protocolForRoute", () => {
	test("reads the protocol off each default route", () => {
		expect(protocolForRoute(PROTOCOL_DEFAULT_ROUTE["openai-completions"])).toBe("openai-completions");
		expect(protocolForRoute(PROTOCOL_DEFAULT_ROUTE["openai-responses"])).toBe("openai-responses");
		expect(protocolForRoute(PROTOCOL_DEFAULT_ROUTE["anthropic-messages"])).toBe("anthropic-messages");
	});

	test("reads it off a vendor's own path, whatever sits in front", () => {
		// Volcengine Ark, which is /api/v3 rather than /v1.
		expect(protocolForRoute("/api/v3/chat/completions")).toBe("openai-completions");
		expect(protocolForRoute("/anthropic/v1/messages")).toBe("anthropic-messages");
	});

	test("is null for a path that speaks none of them", () => {
		expect(protocolForRoute("/api/v3/completion")).toBeNull();
		expect(protocolForRoute("")).toBeNull();
	});
});

describe("parseFullEndpoint", () => {
	test("splits a complete URL into base, route and protocol", () => {
		expect(parseFullEndpoint("https://ark.cn-beijing.volces.com/api/v3/chat/completions")).toEqual({
			baseUrl: "https://ark.cn-beijing.volces.com",
			route: "/api/v3/chat/completions",
			api: "openai-completions",
		});
	});

	test("keeps a non-default port on the base", () => {
		expect(parseFullEndpoint("http://192.168.1.8:8000/v1/messages")).toEqual({
			baseUrl: "http://192.168.1.8:8000",
			route: "/v1/messages",
			api: "anthropic-messages",
		});
	});

	test("tolerates surrounding space and a trailing slash", () => {
		expect(parseFullEndpoint("  https://api.example.com/v1/responses/  ")).toMatchObject({
			route: "/v1/responses",
			api: "openai-responses",
		});
	});

	test("rejects what the backend would reject anyway", () => {
		// Named here so the form can say so while the field is still on screen.
		expect(parseFullEndpoint("ftp://api.example.com/v1/messages")).toBeNull();
		expect(parseFullEndpoint("https://user:pw@api.example.com/v1/messages")).toBeNull();
		expect(parseFullEndpoint("https://api.example.com/v1/messages?key=1")).toBeNull();
		expect(parseFullEndpoint("https://api.example.com/v1/messages#x")).toBeNull();
	});

	test("rejects an address that names no endpoint", () => {
		expect(parseFullEndpoint("https://api.example.com")).toBeNull();
		expect(parseFullEndpoint("https://api.example.com/v1")).toBeNull();
		expect(parseFullEndpoint("not a url")).toBeNull();
		expect(parseFullEndpoint("")).toBeNull();
	});
});
