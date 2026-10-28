import { expect, test } from "bun:test";
import { createGitHubFetch } from "../../src/main/github-network";
import type { ProxyStatus } from "../../src/shared/settings";

test("GitHub requests use Chromium system resolution instead of the model host's resolved proxy", async () => {
	const configurations: unknown[] = [];
	let status: ProxyStatus = { manual: null, source: "system", url: "http://model-only:8080" };
	const response = Response.json({});
	const signal = new AbortController().signal;
	const fetchUpdate = createGitHubFetch({
		proxy: () => status,
		session: () => ({
			setProxy: async (config) => { configurations.push(config); },
			fetch: async (url, init) => {
				expect(url).toBe("https://api.github.com/releases");
				expect(init?.signal).toBe(signal);
				return response;
			},
		}),
	});
	for (const next of [
		status,
		{ manual: null, source: "none" },
		{ manual: "", source: "none" },
		{ manual: "http://127.0.0.1:7890", source: "manual", url: "http://127.0.0.1:7890" },
		{ manual: null, source: "environment", url: "http://127.0.0.1:7891" },
	] satisfies ProxyStatus[]) {
		status = next;
		expect(await fetchUpdate("https://api.github.com/releases", { signal })).toBe(response);
	}
	expect(configurations).toEqual([
		{ mode: "system" }, { mode: "system" }, { mode: "direct" },
		{ mode: "fixed_servers", proxyRules: "http://127.0.0.1:7890" },
		{ mode: "fixed_servers", proxyRules: "http://127.0.0.1:7891" },
	]);
});

test("an update aborted while configuring the proxy does not start an HTTP request", async () => {
	const controller = new AbortController();
	let requests = 0;
	const fetchUpdate = createGitHubFetch({
		proxy: () => ({ manual: null, source: "none" }),
		session: () => ({
			setProxy: async () => { controller.abort(); },
			fetch: async () => { requests++; return Response.json({}); },
		}),
	});
	await expect(fetchUpdate("https://api.github.com/releases", { signal: controller.signal })).rejects.toThrow();
	expect(requests).toBe(0);
});

test("preserves authenticated writes, Request objects and OAuth bodies through the Chromium transport", async () => {
	const calls: Array<{ input: string | Request; init?: RequestInit }> = [];
	const fetchGitHub = createGitHubFetch({
		proxy: () => ({ manual: null, source: "none" }),
		session: () => ({
			setProxy: async () => {},
			fetch: async (input, init) => { calls.push({ input, init }); return Response.json({}); },
		}),
	});
	const init: RequestInit = {
		method: "POST", redirect: "error",
		headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ body: "hello" }),
	};
	await fetchGitHub(new URL("https://api.github.com/repos/neko/project/issues/1/comments"), init);
	expect(calls[0]?.input).toBe("https://api.github.com/repos/neko/project/issues/1/comments");
	expect(calls[0]?.init).toBe(init);
	const request = new Request("https://example.test/github/auth/refresh", { method: "POST", body: "refresh-body" });
	await fetchGitHub(request);
	expect(calls[1]?.input).toBe(request);
	expect(await request.text()).toBe("refresh-body");
});
