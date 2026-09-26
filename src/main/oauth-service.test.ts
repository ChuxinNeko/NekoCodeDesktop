import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { OAuthLoginEvent } from "../shared/settings";
import { OAuthService, oauthLoginOptions, registerOAuthClientIdentity } from "./oauth-service";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Flow = (interaction: AuthInteraction) => Promise<{ type: "oauth"; access: string; refresh: string; expires: number }>;

/** Stands in for pi's runtime: each provider's login runs the scripted flow. */
function fakeRuntime(flows: Record<string, Flow>, sources: Record<string, string> = {}) {
	const stored = new Set<string>();
	const registered: string[] = [];
	const runtime = {
		login: async (providerId: string, _type: string, interaction: AuthInteraction) => {
			const credential = await flows[providerId](interaction);
			stored.add(providerId);
			return credential;
		},
		logout: async (providerId: string) => {
			stored.delete(providerId);
		},
		getProviderAuthStatus: (providerId: string) =>
			stored.has(providerId)
				? { configured: true, source: "stored" }
				: sources[providerId]
					? { configured: true, source: sources[providerId] }
					: { configured: false },
		getModels: (providerId: string) => [{ id: `${providerId}-model`, name: "Model", contextWindow: 1000, maxTokens: 100 }],
		getAuth: async (providerId: string) => (stored.has(providerId) ? { auth: { apiKey: `token-${providerId}` } } : undefined),
		registerProvider: (providerId: string) => registered.push(providerId),
	};
	return { runtime: runtime as unknown as ModelRuntime, registered };
}

function service(flows: Record<string, Flow>, sources?: Record<string, string>, fetch?: typeof globalThis.fetch) {
	const dir = mkdtempSync(join(tmpdir(), "oauth-service-"));
	dirs.push(dir);
	const events: OAuthLoginEvent[] = [];
	const opened: string[] = [];
	const { runtime, registered } = fakeRuntime(flows, sources);
	const oauth = new OAuthService({
		userDataDir: dir,
		getRuntime: async () => runtime,
		openExternal: (url) => opened.push(url),
		emit: (event) => events.push(event),
		...(fetch ? { fetch } : {}),
		readStored: async () => undefined,
	});
	return { oauth, events, opened, runtime, registered };
}

const token = (expires = Date.now() + 3600_000) => ({ type: "oauth" as const, access: "not-a-jwt", refresh: "r", expires });

describe("signing into pi's subscriptions", () => {
	test("offers every new provider next to Codex and Antigravity", async () => {
		const { oauth } = service({});
		expect((await oauth.list()).map((account) => account.id)).toEqual([
			"openai-codex",
			"github-copilot",
			"openrouter",
			"kimi-coding",
			"xai",
			"radius",
			"antigravity",
		]);
	});

	test("a device-code flow shows its code instead of opening a page", async () => {
		const { oauth, events, opened } = service({
			xai: async (interaction) => {
				interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://auth.x.ai/device", expiresInSeconds: 600 });
				return token();
			},
		});
		const before = Date.now();
		const summary = await oauth.login("xai");
		expect(summary).toMatchObject({ id: "xai", signedIn: true, modelIds: ["xai-model"] });
		const device = events.find((event) => event.kind === "device-code");
		expect(device).toMatchObject({ provider: "xai", userCode: "ABCD-1234", verificationUri: "https://auth.x.ai/device" });
		expect(device?.kind === "device-code" && device.expiresAt! >= before + 600_000).toBe(true);
		expect(opened).toEqual([]);
		expect(events.at(-1)).toMatchObject({ kind: "done", provider: "xai" });
	});

	test("Copilot is told which GitHub to sign into, and remembers it", async () => {
		const answers: string[] = [];
		const flow: Flow = async (interaction) => {
			answers.push(await interaction.prompt({ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" }));
			return token();
		};
		const { oauth } = service({ "github-copilot": flow });
		expect((await oauth.login("github-copilot")).accountId).toBeUndefined();
		expect((await oauth.login("github-copilot", { enterpriseDomain: " company.ghe.com " })).accountId).toBe("company.ghe.com");
		expect(answers).toEqual(["", "company.ghe.com"]);
	});

	test("a flow offering several methods gets the configured one", async () => {
		const picked: string[] = [];
		const options = [
			{ id: "browser", label: "Browser" },
			{ id: "device-code", label: "Device code" },
		];
		const flow: Flow = async (interaction) => {
			picked.push(await interaction.prompt({ type: "select", message: "Sign in", options }));
			return token();
		};
		const { oauth } = service({ radius: flow, "openai-codex": flow });
		await oauth.login("radius");
		await oauth.login("openai-codex");
		expect(picked).toEqual(["browser", "browser"]);
	});

	test("OpenRouter's key never expires, so none is recorded", async () => {
		const { oauth, events } = service({
			openrouter: async (interaction) => {
				interaction.notify({ type: "auth_url", url: "https://openrouter.ai/auth?x=1" });
				return token(Number.MAX_SAFE_INTEGER);
			},
		});
		const summary = await oauth.login("openrouter");
		expect(summary.signedIn).toBe(true);
		expect(summary.expiresAt).toBeUndefined();
		expect(events[0]).toEqual({ kind: "url", provider: "openrouter", url: "https://openrouter.ai/auth?x=1" });
	});

	test("an API key from the environment is not an account signed in here", async () => {
		const { oauth } = service({}, { openrouter: "environment" });
		const row = (await oauth.list()).find((account) => account.id === "openrouter");
		expect(row?.signedIn).toBe(false);
	});

	test("a pasted code reaches a flow waiting on one", async () => {
		const { oauth, events } = service({
			openrouter: async (interaction) => {
				const code = await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
				expect(code).toBe("https://localhost/callback?code=abc");
				return token(Number.MAX_SAFE_INTEGER);
			},
		});
		const login = oauth.login("openrouter");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events.some((event) => event.kind === "manual-code")).toBe(true);
		oauth.submitCode("openrouter", "  https://localhost/callback?code=abc  ");
		expect((await login).signedIn).toBe(true);
	});

	test("cancelling a device-code wait reports it as cancelled", async () => {
		const { oauth, events } = service({
			"kimi-coding": (interaction) =>
				new Promise((_resolve, reject) => {
					interaction.notify({ type: "device_code", userCode: "K-1", verificationUri: "https://auth.kimi.com/device" });
					interaction.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")));
				}),
		});
		const login = oauth.login("kimi-coding");
		await new Promise((resolve) => setTimeout(resolve, 0));
		oauth.cancel("kimi-coding");
		await expect(login).rejects.toThrow("Login cancelled");
		expect(events.at(-1)).toEqual({ kind: "cancelled", provider: "kimi-coding" });
	});

	test("signing out forgets the account", async () => {
		const { oauth } = service({ "github-copilot": async () => token() });
		await oauth.login("github-copilot", { enterpriseDomain: "company.ghe.com" });
		const after = await oauth.logout("github-copilot");
		expect(after).toMatchObject({ signedIn: false });
		expect(after.accountId).toBeUndefined();
	});

	test("only Codex has a client identity to pin", () => {
		const { runtime, registered } = service({});
		registerOAuthClientIdentity(runtime);
		expect(registered).toEqual(["openai-codex"]);
	});
});

describe("oauthLoginOptions", () => {
	test("keeps a plausible domain and drops everything else", () => {
		expect(oauthLoginOptions({ enterpriseDomain: " company.ghe.com " })).toEqual({ enterpriseDomain: "company.ghe.com" });
		expect(oauthLoginOptions({ enterpriseDomain: "a b" })).toEqual({});
		expect(oauthLoginOptions({ enterpriseDomain: "" })).toEqual({});
		expect(oauthLoginOptions({ enterpriseDomain: 3 })).toEqual({});
		expect(oauthLoginOptions("company.ghe.com")).toEqual({});
		expect(oauthLoginOptions(undefined)).toEqual({});
	});
});

describe("quota for signed-in subscriptions", () => {
	function counting(body: unknown) {
		let calls = 0;
		const fetch = (async () => {
			calls++;
			return new Response(JSON.stringify(body), { status: 200 });
		}) as unknown as typeof globalThis.fetch;
		return { fetch, calls: () => calls };
	}

	test("a provider not signed in here is not asked", async () => {
		const { fetch, calls } = counting({});
		const { oauth } = service({}, { openrouter: "environment" }, fetch);
		expect(await oauth.usage("openrouter")).toMatchObject({ provider: "openrouter", status: "signed-out" });
		expect(calls()).toBe(0);
	});

	test("asks once a minute unless forced, with pi's token", async () => {
		const { fetch, calls } = counting({ rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: 60 } } });
		const { oauth } = service({ "openai-codex": async () => token() }, undefined, fetch);
		await oauth.login("openai-codex");
		const first = await oauth.usage("openai-codex");
		expect(first.windows[0]).toMatchObject({ label: "5h", usedPercent: 10 });
		await oauth.usage("openai-codex");
		expect(calls()).toBe(1);
		await oauth.usage("openai-codex", true);
		expect(calls()).toBe(2);
	});

	test("signing out drops the quota read for that account", async () => {
		const { fetch, calls } = counting({ usage: { limit: 10, used: 2 } });
		const { oauth } = service({ "kimi-coding": async () => token() }, undefined, fetch);
		await oauth.login("kimi-coding");
		await oauth.usage("kimi-coding");
		await oauth.logout("kimi-coding");
		expect(await oauth.usage("kimi-coding")).toMatchObject({ status: "signed-out" });
		expect(calls()).toBe(1);
	});

	test("an unknown provider is refused", async () => {
		const { oauth } = service({});
		await expect(oauth.usage("nope")).rejects.toThrow("Unknown OAuth provider");
	});
});
