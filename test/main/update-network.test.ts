import { expect, test } from "bun:test";
import { createUpdateFetch } from "../../src/main/update-network";
import type { ProxyStatus } from "../../src/shared/settings";

test("update checks use Chromium system resolution for GitHub instead of the model host's resolved proxy", async () => {
	const configurations: unknown[] = [];
	let status: ProxyStatus = { manual: null, source: "system", url: "http://model-only:8080" };
	const response = Response.json({});
	const signal = new AbortController().signal;
	const fetchUpdate = createUpdateFetch({
		proxy: () => status,
		session: () => ({
			setProxy: async (config) => { configurations.push(config); },
			fetch: async (url, init) => {
				expect(url).toBe("https://api.github.com/releases");
				expect(init.signal).toBe(signal);
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
	const fetchUpdate = createUpdateFetch({
		proxy: () => ({ manual: null, source: "none" }),
		session: () => ({
			setProxy: async () => { controller.abort(); },
			fetch: async () => { requests++; return Response.json({}); },
		}),
	});
	await expect(fetchUpdate("https://api.github.com/releases", { signal: controller.signal })).rejects.toThrow();
	expect(requests).toBe(0);
});
