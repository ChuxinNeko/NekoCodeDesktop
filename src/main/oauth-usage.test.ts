import { describe, expect, test } from "bun:test";
import {
	fetchOAuthUsage,
	parseAntigravityUsage,
	parseCodexUsage,
	parseCopilotUsage,
	parseKimiUsage,
	parseOpenRouterUsage,
	parseXaiBilling,
	type UsageContext,
} from "./oauth-usage";

const NOW = Date.parse("2026-09-25T00:00:00Z");

describe("Codex wham/usage", () => {
	test("reads both windows, the credit balance and the plan", () => {
		const usage = parseCodexUsage(
			{
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_after_seconds: 3600 },
					secondary_window: { used_percent: 130, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 86_400 },
				},
				credits: { has_credits: true, unlimited: false, balance: "12.5" },
			},
			NOW,
		);
		expect(usage.plan).toBe("Plus");
		expect(usage.windows).toEqual([
			{ label: "5h", usedPercent: 42, resetsAt: NOW + 3_600_000 },
			// Clamped: a window cannot be more than used up.
			{ label: "Weekly", usedPercent: 100, resetsAt: NOW + 86_400_000 },
		]);
		expect(usage.metrics).toEqual([{ label: "Credits", value: 12.5, format: "currency", currency: "USD" }]);
	});

	test("no credit line on a plan without credits", () => {
		const usage = parseCodexUsage({ credits: { has_credits: false, balance: 0 } }, NOW);
		expect(usage.metrics).toEqual([]);
		expect(usage.windows).toEqual([]);
	});
});

describe("Copilot copilot_internal/user", () => {
	test("paid plans: premium requests first, unlimited ones marked", () => {
		const usage = parseCopilotUsage(
			{
				copilot_plan: "individual_pro",
				quota_reset_date: "2026-10-01",
				quota_snapshots: {
					chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100 },
					premium_interactions: { unlimited: false, entitlement: 300, remaining: 240, percent_remaining: 80 },
				},
			},
			NOW,
		);
		expect(usage.plan).toBe("Individual Pro");
		expect(usage.windows).toEqual([
			{ label: "Premium requests", usedPercent: 20, used: 60, limit: 300, resetsAt: Date.parse("2026-10-01") },
			{ label: "Chat", unlimited: true },
		]);
	});

	test("the free plan counts down its monthly allowance", () => {
		const usage = parseCopilotUsage(
			{
				limited_user_quotas: { chat: 40, completions: 1500 },
				monthly_quotas: { chat: 50, completions: 2000 },
				limited_user_reset_date: "2026-10-01",
			},
			NOW,
		);
		expect(usage.windows.map((window) => [window.label, window.used, window.limit, window.usedPercent])).toEqual([
			["Chat", 10, 50, 20],
			["Completions", 500, 2000, 25],
		]);
	});
});

describe("OpenRouter /key and /credits", () => {
	test("a capped key fills its bar; the account balance is a figure", () => {
		const usage = parseOpenRouterUsage(
			{ data: { limit: 20, usage: 5, limit_remaining: 15, limit_reset: "monthly", usage_monthly: 3 } },
			{ data: { total_credits: 50, total_usage: 12.25 } },
			NOW,
		);
		expect(usage.windows).toEqual([{ label: "Key limit (monthly)", used: 5, usedPercent: 25, limit: 20 }]);
		expect(usage.metrics.map((metric) => [metric.label, metric.value])).toEqual([
			["Balance", 37.75],
			["Key spend", 5],
			["This month", 3],
		]);
	});

	test("an uncapped key without credits access still reports its spend", () => {
		const usage = parseOpenRouterUsage({ data: { limit: null, usage: 1.5, is_free_tier: true } }, undefined, NOW);
		expect(usage.windows).toEqual([]);
		expect(usage.plan).toBe("Free tier");
		expect(usage.metrics).toEqual([{ label: "Key spend", value: 1.5, format: "currency", currency: "USD" }]);
	});
});

describe("Kimi Code /usages", () => {
	test("the overall allowance, then the rolling windows under it", () => {
		const usage = parseKimiUsage(
			{
				usage: { limit: "1000", used: "250", resetTime: "2026-09-29T00:00:00Z" },
				limits: [
					{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "70", resetTime: "2026-09-25T03:00:00Z" } },
					{ name: "Burst", detail: { limit: 10, used: 10 } },
				],
			},
			NOW,
		);
		expect(usage.windows).toEqual([
			{ label: "Weekly", used: 250, limit: 1000, usedPercent: 25, resetsAt: Date.parse("2026-09-29T00:00:00Z") },
			{ label: "5h", used: 30, limit: 100, usedPercent: 30, resetsAt: Date.parse("2026-09-25T03:00:00Z") },
			{ label: "Burst", used: 10, limit: 10, usedPercent: 100 },
		]);
	});
});

describe("xAI billing", () => {
	test("a unified-billing account has a weekly credit window", () => {
		const usage = parseXaiBilling(
			{ config: { creditUsagePercent: 0.4, isUnifiedBillingUser: true, currentPeriod: { end: "2026-09-28T00:00:00Z" }, onDemandUsed: { val: 2 }, onDemandCap: 10 } },
			{ subscription_tier_display: "SuperGrok Heavy" },
			NOW,
		);
		expect(usage.plan).toBe("SuperGrok Heavy");
		expect(usage.windows).toEqual([{ label: "Weekly", usedPercent: 40, resetsAt: Date.parse("2026-09-28T00:00:00Z") }]);
		expect(usage.metrics).toEqual([{ label: "On-demand", value: 2, format: "currency", currency: "USD" }]);
	});

	test("without a percent, spend against the monthly limit", () => {
		const usage = parseXaiBilling({ monthlyLimit: 50, usage: { totalUsed: 10 } }, undefined, NOW);
		expect(usage.windows).toEqual([{ label: "Credits", usedPercent: 20, resetsAt: undefined }]);
	});
});

describe("Antigravity loadCodeAssist + fetchAvailableModels", () => {
	test("tier, Google One AI credits, and the models closest to running out", () => {
		const usage = parseAntigravityUsage(
			{
				currentTier: { id: "standard-tier", name: "Gemini Code Assist" },
				paidTier: {
					id: "g1-pro-tier",
					name: "Google AI Pro",
					availableCredits: [
						{ creditType: "GOOGLE_ONE_AI", creditAmount: "1000", minimumCreditAmountForUsage: "50" },
						{ creditType: "OTHER", creditAmount: "5" },
					],
				},
			},
			{
				models: {
					"gemini-3-pro": { displayName: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.25, resetTime: "2026-09-25T05:00:00Z" } },
					"gemini-3-pro-high": { displayName: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.5 } },
					"claude-sonnet": { displayName: "Claude Sonnet", quotaInfo: { remainingFraction: 1 } },
					"no-quota": { displayName: "Internal" },
				},
			},
			NOW,
		);
		expect(usage.plan).toBe("Google AI Pro");
		expect(usage.metrics).toEqual([{ label: "AI credits", value: 1000, format: "number" }]);
		expect(usage.windows).toEqual([
			{ label: "Gemini 3 Pro", usedPercent: 75, resetsAt: Date.parse("2026-09-25T05:00:00Z") },
			{ label: "Claude Sonnet", usedPercent: 0 },
		]);
	});
});

describe("fetchOAuthUsage", () => {
	function context(responses: Record<string, { status?: number; body: unknown }>, overrides: Partial<UsageContext> = {}) {
		const requests: Array<{ url: string; headers: Record<string, string> }> = [];
		const ctx: UsageContext = {
			now: NOW,
			signal: new AbortController().signal,
			fetch: async (input, init) => {
				const url = String(input);
				requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
				const hit = Object.entries(responses).find(([prefix]) => url.startsWith(prefix));
				if (!hit) return new Response("not found", { status: 404 });
				return new Response(JSON.stringify(hit[1].body), { status: hit[1].status ?? 200 });
			},
			token: async (providerId) => `token-${providerId}`,
			stored: async () => undefined,
			...overrides,
		};
		return { ctx, requests };
	}

	test("Codex is asked with pi's token and the pinned client identity", async () => {
		const { ctx, requests } = context({ "https://chatgpt.com/backend-api/wham/usage": { body: { plan_type: "pro" } } });
		const usage = await fetchOAuthUsage("openai-codex", ctx);
		expect(usage.plan).toBe("Pro");
		expect(requests[0].headers).toMatchObject({ Authorization: "Bearer token-openai-codex", originator: "codex-tui" });
	});

	test("Copilot is asked with the GitHub token, on the Enterprise host when there is one", async () => {
		const { ctx, requests } = context(
			{ "https://api.company.ghe.com/copilot_internal/user": { body: { copilot_plan: "business" } } },
			{ stored: async () => ({ type: "oauth", refresh: "gho_github", access: "copilot", enterpriseUrl: "company.ghe.com" }) },
		);
		const usage = await fetchOAuthUsage("github-copilot", ctx);
		expect(usage).toMatchObject({ status: "ok", plan: "Business" });
		expect(requests[0].headers.Authorization).toBe("token gho_github");
	});

	test("OpenRouter still reports when the credits endpoint refuses the key", async () => {
		const { ctx } = context({
			"https://openrouter.ai/api/v1/key": { body: { data: { usage: 2 } } },
			"https://openrouter.ai/api/v1/credits": { status: 403, body: {} },
		});
		const usage = await fetchOAuthUsage("openrouter", ctx);
		expect(usage.status).toBe("ok");
		expect(usage.metrics.map((metric) => metric.label)).toEqual(["Key spend"]);
	});

	test("Kimi and xAI go to their own endpoints", async () => {
		const kimi = context({ "https://api.kimi.com/coding/v1/usages": { body: { usage: { limit: 10, used: 1 } } } });
		expect((await fetchOAuthUsage("kimi-coding", kimi.ctx)).windows[0]).toMatchObject({ used: 1, limit: 10 });
		const xai = context({ "https://cli-chat-proxy.grok.com/v1/billing": { body: { monthlyLimit: 10, usage: { totalUsed: 5 } } } });
		expect((await fetchOAuthUsage("xai", xai.ctx)).windows[0]).toMatchObject({ usedPercent: 50 });
		expect(xai.requests[0].headers["x-xai-token-auth"]).toBe("xai-grok-cli");
	});

	test("Antigravity goes through its own service; a models failure keeps the tier", async () => {
		const calls: string[] = [];
		const { ctx } = context(
			{},
			{
				antigravity: async (method) => {
					calls.push(method);
					if (method === "fetchAvailableModels") throw new Error("boom");
					return { currentTier: { name: "Free" } };
				},
			},
		);
		const usage = await fetchOAuthUsage("antigravity", ctx);
		expect(calls).toEqual(["loadCodeAssist", "fetchAvailableModels"]);
		expect(usage).toMatchObject({ status: "ok", plan: "Free", message: "供应商没有返回额度信息。" });
	});

	test("a rejected token reads as a login problem, not a crash", async () => {
		const { ctx } = context({ "https://chatgpt.com/backend-api/wham/usage": { status: 401, body: {} } });
		const usage = await fetchOAuthUsage("openai-codex", ctx);
		expect(usage.status).toBe("error");
		expect(usage.message).toContain("HTTP 401");
		expect(usage.message).toContain("登录可能已失效");
	});

	test("no token is signed out; Radius has nothing to ask", async () => {
		const { ctx } = context({}, { token: async () => undefined });
		expect((await fetchOAuthUsage("xai", ctx)).status).toBe("signed-out");
		expect(await fetchOAuthUsage("radius", ctx)).toMatchObject({ status: "unsupported" });
	});
});
