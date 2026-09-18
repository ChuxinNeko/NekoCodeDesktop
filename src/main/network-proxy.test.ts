import { describe, expect, test } from "bun:test";
import {
	isProxyExempt,
	normalizeProxyUrl,
	parseSystemProxyRules,
	proxyFromEnvironment,
	resolveProxy,
} from "./network-proxy";

const TARGET = "https://chatgpt.com/backend-api/codex/responses";

describe("normalizeProxyUrl", () => {
	test("accepts what proxy clients actually print", () => {
		// A bare host:port is how Clash, the Windows proxy dialog and most
		// READMEs present one.
		expect(normalizeProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890/");
		expect(normalizeProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890/");
		expect(normalizeProxyUrl("https://proxy.corp:8443")).toBe("https://proxy.corp:8443/");
		expect(normalizeProxyUrl("  127.0.0.1:7890  ")).toBe("http://127.0.0.1:7890/");
	});

	test("rejects what the dispatcher could not use", () => {
		expect(normalizeProxyUrl("")).toBeUndefined();
		expect(normalizeProxyUrl("not a url")).toBeUndefined();
		// SOCKS needs a different transport; accepting it here would fail later,
		// at a point where the cause is no longer obvious.
		expect(normalizeProxyUrl("socks5://127.0.0.1:7891")).toBeUndefined();
	});
});

describe("isProxyExempt", () => {
	test("matches a host, its subdomains, and the catch-all", () => {
		expect(isProxyExempt("chatgpt.com", "chatgpt.com")).toBe(true);
		expect(isProxyExempt("api.chatgpt.com", ".chatgpt.com")).toBe(true);
		expect(isProxyExempt("chatgpt.com", "localhost,127.0.0.1")).toBe(false);
		expect(isProxyExempt("chatgpt.com", "*")).toBe(true);
		expect(isProxyExempt("chatgpt.com", undefined)).toBe(false);
	});
});

describe("proxyFromEnvironment", () => {
	test("prefers the protocol-specific variable over the catch-all", () => {
		expect(
			proxyFromEnvironment({ HTTPS_PROXY: "127.0.0.1:7890", ALL_PROXY: "127.0.0.1:1080" }, "chatgpt.com"),
		).toBe("http://127.0.0.1:7890/");
		expect(proxyFromEnvironment({ all_proxy: "127.0.0.1:1080" }, "chatgpt.com")).toBe("http://127.0.0.1:1080/");
	});

	test("honours NO_PROXY", () => {
		expect(proxyFromEnvironment({ HTTPS_PROXY: "127.0.0.1:7890", NO_PROXY: "chatgpt.com" }, "chatgpt.com")).toBeUndefined();
	});

	test("an unusable value does not shadow a usable one", () => {
		expect(proxyFromEnvironment({ HTTPS_PROXY: "socks5://x:1", HTTP_PROXY: "127.0.0.1:7890" }, "chatgpt.com")).toBe(
			"http://127.0.0.1:7890/",
		);
	});
});

describe("parseSystemProxyRules", () => {
	test("reads Chromium's resolution", () => {
		expect(parseSystemProxyRules("PROXY 127.0.0.1:7890; DIRECT")).toEqual({
			url: "http://127.0.0.1:7890/",
			source: "system",
		});
		expect(parseSystemProxyRules("HTTPS proxy.corp:8443")).toEqual({
			url: "https://proxy.corp:8443/",
			source: "system",
		});
	});

	test("a direct connection is not a proxy", () => {
		expect(parseSystemProxyRules("DIRECT")).toEqual({ source: "none" });
		expect(parseSystemProxyRules("")).toEqual({ source: "none" });
	});

	test("a SOCKS-only system proxy is reported, not silently ignored", () => {
		// Ignoring it would be indistinguishable from having no proxy, which is
		// exactly the confusion this whole module exists to end.
		const result = parseSystemProxyRules("SOCKS5 127.0.0.1:7891");

		expect(result.url).toBeUndefined();
		expect(result.warning).toContain("SOCKS");
	});
});

describe("resolveProxy", () => {
	test("a manual setting wins over everything else", async () => {
		expect(
			await resolveProxy({
				manual: "127.0.0.1:1080",
				env: { HTTPS_PROXY: "127.0.0.1:7890" },
				targetUrl: TARGET,
				resolveSystemProxy: async () => "PROXY 127.0.0.1:3128",
			}),
		).toEqual({ url: "http://127.0.0.1:1080/", source: "manual" });
	});

	test("an emptied manual setting means direct, not 'go looking'", async () => {
		expect(
			await resolveProxy({
				manual: "",
				env: { HTTPS_PROXY: "127.0.0.1:7890" },
				targetUrl: TARGET,
				resolveSystemProxy: async () => "PROXY 127.0.0.1:3128",
			}),
		).toEqual({ source: "none" });
	});

	test("the environment beats the system proxy", async () => {
		expect(
			await resolveProxy({
				env: { HTTPS_PROXY: "127.0.0.1:7890" },
				targetUrl: TARGET,
				resolveSystemProxy: async () => "PROXY 127.0.0.1:3128",
			}),
		).toEqual({ url: "http://127.0.0.1:7890/", source: "environment" });
	});

	test("falls back to whatever the browser would use", async () => {
		expect(
			await resolveProxy({
				env: {},
				targetUrl: TARGET,
				resolveSystemProxy: async () => "PROXY 127.0.0.1:3128; DIRECT",
			}),
		).toEqual({ url: "http://127.0.0.1:3128/", source: "system" });
	});

	test("a system resolution that throws leaves the connection direct", async () => {
		expect(
			await resolveProxy({
				env: {},
				targetUrl: TARGET,
				resolveSystemProxy: async () => {
					throw new Error("session unavailable");
				},
			}),
		).toEqual({ source: "none" });
	});
});
