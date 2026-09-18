import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelProfileSummary, OAuthProviderSummary } from "../shared/settings";
import type { OAuthLoginState } from "../renderer/src/components/settings/ProviderModelSettings";

// Same bridge stand-in as the other renderer tests: importing settings panels
// must not reach for Electron's preload API.
const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { ProvidersTab, emptyProviderDraft, providerDraftFrom, isDraftComplete } = await import(
	"../renderer/src/components/settings/ProvidersTab"
);
const { ModelsTab } = await import("../renderer/src/components/settings/ModelsTab");
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

const render = (element: ReturnType<typeof createElement>) =>
	renderToStaticMarkup(createElement(I18nProvider, { children: element }));

const profile = (overrides: Partial<ModelProfileSummary> = {}): ModelProfileSummary => ({
	id: "p1",
	kind: "custom-api",
	name: "OpenRouter",
	baseUrl: "https://openrouter.ai/api",
	route: "/v1/chat/completions",
	api: "openai-completions",
	modelIds: ["gpt-4o"],
	reasoning: false,
	hasApiKey: true,
	createdAt: 1,
	updatedAt: 2,
	...overrides,
});

const account = (overrides: Partial<OAuthProviderSummary> = {}): OAuthProviderSummary => ({
	id: "openai-codex",
	providerId: "openai-codex",
	name: "OpenAI (ChatGPT)",
	signedIn: true,
	accountId: "acc_1",
	email: "someone@example.com",
	plan: "pro",
	modelIds: ["gpt-5.5", "gpt-5.3-codex-spark"],
	...overrides,
});

const providers = (
	profiles: ModelProfileSummary[],
	draft: Parameters<typeof ProvidersTab>[0]["draft"],
	extra: { accounts?: OAuthProviderSummary[]; login?: OAuthLoginState | null } = {},
) =>
	render(
		createElement(ProvidersTab, {
			profiles,
			accounts: extra.accounts ?? [],
			login: extra.login ?? null,
			draft,
			busy: false,
			onDraftChange: () => {},
			onSave: () => {},
			onDelete: () => {},
			onLogin: () => {},
			onCancelLogin: () => {},
			onSubmitCode: () => {},
			onLogout: () => {},
			onManageModels: () => {},
		}),
	);

const models = (profiles: ModelProfileSummary[], accounts: OAuthProviderSummary[] = []) =>
	render(
		createElement(ModelsTab, {
			profiles,
			accounts,
			profile: profiles[0] ?? null,
			busy: false,
			autoFetchId: null,
			onSelect: () => {},
			onAutoFetchHandled: () => {},
			onFetch: async () => null,
			onSaveModels: () => {},
			onTest: () => {},
			onAddProvider: () => {},
		}),
	);

describe("providers tab", () => {
	test("Antigravity OAuth exposes its chat models and manual model tests", () => {
		const antigravity = account({ id: "antigravity", providerId: "antigravity", name: "Antigravity (Google)", modelIds: ["claude-sonnet-4-6"], plan: undefined });
		const html = providers([], { ...emptyProviderDraft(), kind: "oauth", oauthProvider: "antigravity" }, { accounts: [antigravity] });
		expect(html).toContain('value="antigravity"');
		expect(html).toContain("Google 账号");
		expect(html).not.toContain("聊天模型尚未接入");
		expect(models([], [antigravity])).toContain("claude-sonnet-4-6");
	});
	test("a row shows where requests go and how many models are picked", () => {
		const html = providers([profile()], null);

		expect(html).toContain("OpenRouter");
		expect(html).toContain("https://openrouter.ai/api/v1/chat/completions");
		expect(html).toContain("1 个模型");
	});

	test("the form offers both provider types", () => {
		const html = providers([], emptyProviderDraft());

		expect(html).toContain("类型");
		expect(html).toContain("自定义 API");
		expect(html).toContain('value="oauth"');
		expect(html).not.toContain('value="oauth" disabled=""');
		expect(emptyProviderDraft().kind).toBe("custom-api");
	});

	test("an OAuth draft asks for a sign-in instead of an endpoint", () => {
		const html = providers([], { ...emptyProviderDraft(), kind: "oauth" }, { accounts: [account()] });

		expect(html).toContain("OAuth 供应商");
		expect(html).toContain("OpenAI (ChatGPT)");
		expect(html).toContain("登录");
		// None of the custom-API fields belong to a subscription.
		expect(html).not.toContain("API 基础 URL");
		expect(html).not.toContain("API 密钥");
	});

	test("a signed-in subscription names the account and offers to sign out", () => {
		const html = providers([], null, { accounts: [account()] });

		expect(html).toContain("OpenAI (ChatGPT)");
		expect(html).toContain("pro");
		expect(html).toContain("someone@example.com");
		expect(html).toContain("退出登录");
		expect(html).toContain("由订阅提供");
	});

	test("a sign-in in flight shows the page it opened and can be cancelled", () => {
		const html = providers([], null, {
			accounts: [account({ signedIn: false })],
			login: { provider: "openai-codex", url: "https://auth.openai.com/oauth/authorize?x=1", manual: false },
		});

		expect(html).toContain("等待浏览器完成登录");
		expect(html).toContain("https://auth.openai.com/oauth/authorize?x=1");
		expect(html).toContain("取消");
		// The paste box is the fallback for a blocked callback port, not a step.
		expect(html).not.toContain("粘贴授权码或回调 URL");
	});

	test("a blocked callback falls back to pasting the code by hand", () => {
		const html = providers([], null, {
			accounts: [account({ signedIn: false })],
			login: { provider: "openai-codex", manual: true },
		});

		expect(html).toContain("粘贴授权码或回调 URL");
	});

	test("a provider with no models points at the tab that fills it", () => {
		const html = providers([profile({ modelIds: [] })], null);

		expect(html).toContain("尚未添加模型");
		expect(html).toContain("「模型」页");
	});

	test("the form hides the route until asked, and a new provider needs a key", () => {
		const draft = emptyProviderDraft();
		const html = providers([], { ...draft, name: "Local", baseUrl: "https://api.local" });

		expect(html).toContain("新建供应商");
		expect(html).toContain("高级（自定义路由）");
		// The endpoint preview spells out what base URL plus route resolves to.
		expect(html).toContain("https://api.local/v1/chat/completions");
		// Nothing is stored yet, so a blank key cannot mean "keep the saved one".
		expect(isDraftComplete({ ...draft, name: "Local", baseUrl: "https://api.local" })).toBe(false);
		expect(
			isDraftComplete({ ...draft, name: "Local", baseUrl: "https://api.local", apiKey: "sk-1" }),
		).toBe(true);
	});

	test("editing keeps the stored key and reveals a non-default route", () => {
		const draft = providerDraftFrom(profile({ route: "/openai/v1/chat/completions" }));

		expect(draft.advanced).toBe(true);
		expect(draft.apiKey).toBe("");
		expect(isDraftComplete(draft)).toBe(true);
		expect(providerDraftFrom(profile()).advanced).toBe(false);
	});
});

describe("models tab", () => {
	test("with no provider it offers the step that has to come first", () => {
		const html = models([]);

		expect(html).toContain("请先添加供应商");
		expect(html).toContain("添加供应商");
	});

	test("it lists the picked models and offers to pull the provider's list", () => {
		const html = models([profile({ modelIds: ["gpt-4o", "o3-mini"] })]);

		expect(html).toContain("已启用的模型");
		expect(html).toContain("gpt-4o");
		expect(html).toContain("o3-mini");
		// Nothing fetched yet, so the button is an invitation, not a refresh.
		expect(html).toContain("获取模型列表");
		expect(html).not.toContain("刷新列表");
		expect(html).toContain("手动添加模型 ID");
	});

	test("a provider with nothing picked says so instead of showing an empty list", () => {
		expect(models([profile({ modelIds: [] })])).toContain("尚未启用任何模型");
	});

	test("a subscription's models are stated, not offered as a choice", () => {
		const html = models([profile()], [account()]);

		expect(html).toContain("OpenAI (ChatGPT)");
		expect(html).toContain("2 个模型");
		expect(html).toContain("无需在此选择");
	});
});
