import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	advertisedAuthMethods,
	CURSOR_AUTH,
	devinAuthPlan,
	devinCredentialsPath,
	DROID_AUTH,
	GROK_AUTH,
	parseDevinCredentials,
} from "./auth";

describe("choosing how an agent signs in", () => {
	test("Cursor reuses its stored login, headless", async () => {
		expect(await CURSOR_AUTH.choose([], {})).toEqual({ methodId: "cursor_login", meta: { headless: true } });
	});

	test("Grok prefers an API key when one is set, else its cached login", async () => {
		const both = ["xai.api_key", "cached_token"];
		expect(await GROK_AUTH.choose(both, { xai_api_key: "k" })).toEqual({ methodId: "xai.api_key" });
		expect(await GROK_AUTH.choose(both, {})).toEqual({ methodId: "cached_token" });
		expect(await GROK_AUTH.choose([], {})).toBeNull();
	});

	test("Grok with only a browser login says to run grok login", async () => {
		await expect(GROK_AUTH.choose(["browser_login"], {})).rejects.toThrow("grok login");
		await expect(GROK_AUTH.choose(["xai.api_key"], {})).rejects.toThrow("XAI_API_KEY");
	});

	test("Droid uses FACTORY_API_KEY when set, else its stored login", async () => {
		const both = ["factory-api-key", "device-pairing"];
		expect(await DROID_AUTH.choose(both, { FACTORY_API_KEY: "k" })).toEqual({ methodId: "factory-api-key" });
		expect(await DROID_AUTH.choose(both, {})).toEqual({ methodId: "device-pairing" });
		await expect(DROID_AUTH.choose(["something-else"], {})).rejects.toThrow("FACTORY_API_KEY");
	});

	test("Devin signs in only when asked, with the key its CLI stored", async () => {
		const plan = devinAuthPlan(async () => ({ apiKey: "stored", apiServerUrl: "https://api.example.com" }));
		expect(plan.when).toBe("on-demand");
		expect(await plan.choose(["windsurf-api-key"], {})).toEqual({
			methodId: "windsurf-api-key",
			meta: { headless: true, api_key: "stored", api_server_url: "https://api.example.com" },
		});
		// The environment wins over the stored file.
		expect((await plan.choose(["windsurf-api-key"], { WINDSURF_API_KEY: "env" }))?.meta).toMatchObject({ api_key: "env" });
		// Builds that advertise only the browser login still take the key.
		expect((await plan.choose(["devin-browser"], {}))?.methodId).toBe("windsurf-api-key");
	});

	test("Devin never sends a key to a plain-HTTP server elsewhere", async () => {
		const plan = devinAuthPlan(async () => ({ apiKey: "k", apiServerUrl: "http://evil.example.com" }));
		expect((await plan.choose(["windsurf-api-key"], {}))?.meta).toEqual({ headless: true, api_key: "k" });
		const local = devinAuthPlan(async () => ({ apiKey: "k", apiServerUrl: "http://127.0.0.1:8080" }));
		expect((await local.choose(["windsurf-api-key"], {}))?.meta).toMatchObject({ api_server_url: "http://127.0.0.1:8080" });
	});

	test("Devin without any login says to run devin auth login", async () => {
		const plan = devinAuthPlan(async () => undefined);
		expect(await plan.choose(["cached_token", "devin-browser"], {})).toMatchObject({ methodId: "cached_token" });
		await expect(plan.choose(["devin-browser", "oauth"], {})).rejects.toThrow("devin auth login");
	});
});

describe("Devin's stored credentials", () => {
	test("reads the key and server, ignoring comments and the rest", () => {
		const raw = ['# comment', 'windsurf_api_key = "sk-1" # trailing', "api_server_url = 'https://x.dev'", 'other = "no"'].join("\n");
		expect(parseDevinCredentials(raw)).toEqual({ apiKey: "sk-1", apiServerUrl: "https://x.dev" });
		expect(parseDevinCredentials("nothing = 1")).toBeUndefined();
	});

	test("lives under APPDATA on Windows and the XDG data dir elsewhere", () => {
		expect(devinCredentialsPath({ APPDATA: join("C:", "AppData") }, "win32")).toBe(join("C:", "AppData", "devin", "credentials.toml"));
		expect(devinCredentialsPath({ HOME: "/home/neko" }, "linux")).toBe(join("/home/neko", ".local", "share", "devin", "credentials.toml"));
	});
});

test("advertisedAuthMethods reads ids, skipping anything malformed", () => {
	expect(advertisedAuthMethods({ authMethods: [{ id: " cached_token " }, { name: "no id" }, null, { id: 3 }] })).toEqual(["cached_token"]);
	expect(advertisedAuthMethods(null)).toEqual([]);
});
