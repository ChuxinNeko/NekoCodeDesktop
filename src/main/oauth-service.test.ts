import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { OAuthLoginEvent } from "../shared/settings";
import { CODEX_CLIENT_HEADERS } from "./openai-codex";
import { OAuthService, registerOAuthClientIdentity } from "./oauth-service";

const sandboxes: string[] = [];

function sandbox(): string {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "nekocode-oauth-test-"));
	sandboxes.push(root);
	return root;
}

afterEach(() => {
	const tempRoot = realpathSync(tmpdir());
	for (const root of sandboxes.splice(0)) {
		const target = realpathSync(root);
		if (!target.startsWith(resolve(tempRoot) + sep) || !basename(target).startsWith("nekocode-oauth-test-")) {
			throw new Error("Refusing unsafe test cleanup");
		}
		rmSync(target, { recursive: true, force: true });
	}
});

function accessToken(claims: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const CODEX_TOKEN = accessToken({
	email: "someone@example.com",
	"https://api.openai.com/auth": { chatgpt_account_id: "acc_1", chatgpt_plan_type: "pro" },
});

interface FakeRuntime {
	runtime: ModelRuntime;
	registered: { providerId: string; config: { headers?: Record<string, string> } }[];
	loginCalls: { providerId: string; type: string }[];
	logoutCalls: string[];
	prompts: AuthPrompt[];
	signedIn: boolean;
}

/** The slice of the model runtime this service touches, and nothing else. */
function fakeRuntime(options: { signedIn?: boolean; onLogin?: (i: AuthInteraction) => Promise<void> } = {}) {
	const state: FakeRuntime = {
		registered: [],
		loginCalls: [],
		logoutCalls: [],
		prompts: [],
		signedIn: options.signedIn ?? false,
		runtime: undefined as unknown as ModelRuntime,
	};
	state.runtime = {
		registerProvider: (providerId: string, config: { headers?: Record<string, string> }) => {
			state.registered.push({ providerId, config });
		},
		getProviderAuthStatus: () => ({ configured: state.signedIn }),
		getModels: () => [{ id: "gpt-5.5" }, { id: "gpt-5.3-codex-spark" }],
		login: async (providerId: string, type: string, interaction: AuthInteraction) => {
			state.loginCalls.push({ providerId, type });
			state.prompts.push();
			await options.onLogin?.(interaction);
			state.signedIn = true;
			return { type: "oauth", access: CODEX_TOKEN, refresh: "r", expires: 1_800_000_000_000 };
		},
		logout: async (providerId: string) => {
			state.logoutCalls.push(providerId);
			state.signedIn = false;
		},
	} as unknown as ModelRuntime;
	return state;
}

function service(fake: FakeRuntime, userDataDir: string, events: OAuthLoginEvent[] = []) {
	const opened: string[] = [];
	const instance = new OAuthService({
		userDataDir,
		getRuntime: async () => fake.runtime,
		openExternal: (url) => opened.push(url),
		emit: (event) => events.push(event),
	});
	return { instance, opened, events };
}

describe("client identity", () => {
	test("is pinned onto every OAuth provider the moment a runtime exists", () => {
		const fake = fakeRuntime();

		registerOAuthClientIdentity(fake.runtime);

		expect(fake.registered).toEqual([
			{ providerId: "openai-codex", config: { headers: CODEX_CLIENT_HEADERS } },
		]);
	});

	test("a provider the core rejects does not take startup down with it", () => {
		const fake = fakeRuntime();
		fake.runtime.registerProvider = () => {
			throw new Error("unknown provider");
		};

		expect(() => registerOAuthClientIdentity(fake.runtime)).not.toThrow();
	});
});

describe("listing", () => {
	test("a signed-out provider is offered without account details", async () => {
		const fake = fakeRuntime({ signedIn: false });
		const { instance } = service(fake, sandbox());

		const [openai] = await instance.list();

		expect(openai?.id).toBe("openai-codex");
		expect(openai?.signedIn).toBe(false);
		expect(openai?.email).toBeUndefined();
		// The models exist either way; what is missing is permission to call them.
		expect(openai?.modelIds).toEqual(["gpt-5.5", "gpt-5.3-codex-spark"]);
	});
});

describe("sign-in", () => {
	test("answers the core's method prompt with the browser flow and opens the page", async () => {
		const answers: string[] = [];
		const fake = fakeRuntime({
			onLogin: async (interaction) => {
				interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize?x=1" });
				answers.push(
					await interaction.prompt({
						type: "select",
						message: "method",
						options: [{ id: "browser", label: "Browser" }],
					}),
				);
			},
		});
		const { instance, opened, events } = service(fake, sandbox());

		const account = await instance.login("openai-codex");

		expect(fake.loginCalls).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
		expect(answers).toEqual(["browser"]);
		expect(opened).toEqual(["https://auth.openai.com/oauth/authorize?x=1"]);
		expect(events.some((event) => event.kind === "url")).toBe(true);
		expect(events.at(-1)).toEqual({ kind: "done", provider: "openai-codex", account });
		// Named from the token, so the row says which account is signed in.
		expect(account.email).toBe("someone@example.com");
		expect(account.plan).toBe("pro");
		expect(account.accountId).toBe("acc_1");
		expect(account.expiresAt).toBe(1_800_000_000_000);
		expect(account.signedIn).toBe(true);
	});

	test("the manual-code prompt waits for a paste instead of failing the flow", async () => {
		// The core races this prompt against its callback server: rejecting it
		// early would abort a sign-in that was about to succeed.
		let pasted: string | undefined;
		const fake = fakeRuntime({
			onLogin: async (interaction) => {
				const code = interaction.prompt({ type: "manual_code", message: "Paste it" });
				await Bun.sleep(1);
				instance.submitCode("openai-codex", "  abc123  ");
				pasted = await code;
			},
		});
		const { instance, events } = service(fake, sandbox());

		await instance.login("openai-codex");

		expect(pasted).toBe("abc123");
		expect(events.some((event) => event.kind === "manual-code")).toBe(true);
	});

	test("a cancelled sign-in reports cancellation rather than an error", async () => {
		const fake = fakeRuntime({
			onLogin: (interaction) =>
				new Promise((_resolve, reject) => {
					interaction.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")), {
						once: true,
					});
					setTimeout(() => instance.cancel("openai-codex"), 1);
				}),
		});
		const { instance, events } = service(fake, sandbox());

		await expect(instance.login("openai-codex")).rejects.toThrow("Login cancelled");
		expect(events.at(-1)).toEqual({ kind: "cancelled", provider: "openai-codex" });
	});

	test("two sign-ins for one provider cannot run at once", async () => {
		const fake = fakeRuntime({ onLogin: () => Bun.sleep(20) });
		const { instance } = service(fake, sandbox());

		const first = instance.login("openai-codex");
		await expect(instance.login("openai-codex")).rejects.toThrow("正在登录");
		await first;
	});
});

describe("sign-out", () => {
	test("drops the credential and the cached account with it", async () => {
		const dir = sandbox();
		const fake = fakeRuntime();
		const { instance } = service(fake, dir);
		await instance.login("openai-codex");
		const cachePath = join(dir, "oauth-accounts.json");
		expect(JSON.parse(readFileSync(cachePath, "utf8"))["openai-codex"].email).toBe("someone@example.com");

		const account = await instance.logout("openai-codex");

		expect(fake.logoutCalls).toEqual(["openai-codex"]);
		expect(account.signedIn).toBe(false);
		expect(account.email).toBeUndefined();
		expect(existsSync(cachePath)).toBe(true);
		expect(JSON.parse(readFileSync(cachePath, "utf8"))["openai-codex"]).toBeUndefined();
	});
});
