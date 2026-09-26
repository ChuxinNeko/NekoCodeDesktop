/**
 * How much of each subscription is left.
 *
 * Tokens come from where they already live: pi's runtime for the providers pi
 * signs into — `getAuth` hands back the same refreshed token a model request
 * would carry — and NekoCode's own Antigravity service for that one. Nothing
 * here stores or refreshes a credential of its own.
 *
 * What each endpoint means is taken from projects that already read them:
 * CLIProxyAPI for the normalized shape and the Codex rate-limit and Antigravity
 * credit semantics (`helps/codex_quota.go`, `antigravity_executor_credits.go`,
 * `pluginapi.QuotaFetchResponse`), Synara for the concrete Codex, Antigravity
 * and Grok requests, kimi-cli for Kimi Code's `/usages`. Copilot's
 * `copilot_internal/user` and OpenRouter's `/key` are the endpoints their own
 * clients use. None of these are public contracts, so every parser reads
 * defensively and a field that is missing just does not show.
 */
import type {
	OAuthProviderId,
	OAuthUsageMetric,
	OAuthUsageSnapshot,
	OAuthUsageWindow,
} from "../shared/settings";
import { CODEX_CLIENT_HEADERS, readCodexClaims } from "./openai-codex";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface UsageContext {
	now: number;
	fetch: FetchLike;
	signal: AbortSignal;
	/** The token pi would send for this provider right now, refreshed if it had to be. */
	token(providerId: string): Promise<string | undefined>;
	/** pi's stored credential, for what a request token does not carry (Copilot's GitHub token). */
	stored(providerId: string): Promise<Record<string, unknown> | undefined>;
	/** A Cloud Code call as the signed-in Antigravity account. */
	antigravity?: (method: "loadCodeAssist" | "fetchAvailableModels", body: object) => Promise<unknown>;
}

/** The endpoint answered, but not with a success. */
export class UsageHttpError extends Error {
	constructor(
		readonly status: number,
		what: string,
	) {
		super(`${what} 请求失败（HTTP ${status}）`);
		this.name = "UsageHttpError";
	}
}

// --- reading loosely typed JSON ------------------------------------------------

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	const nested = record(value);
	// Some billing APIs wrap amounts as `{ val: 12.3 }`.
	return nested ? num(nested.val) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function first(object: Record<string, unknown> | undefined, ...keys: string[]): unknown {
	if (!object) return undefined;
	for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key];
	return undefined;
}

function clampPercent(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.min(100, Math.max(0, value));
}

/** An ISO string, epoch seconds or epoch ms, as epoch ms. */
function timeOf(value: unknown): number | undefined {
	const n = num(value);
	if (n !== undefined && n > 0) return n < 1e12 ? n * 1000 : n;
	const text = str(value);
	if (!text) return undefined;
	const parsed = Date.parse(text);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function titleCase(value: string): string {
	return value
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function snapshot(
	provider: OAuthProviderId,
	now: number,
	fields: Partial<Omit<OAuthUsageSnapshot, "provider" | "fetchedAt">> = {},
): OAuthUsageSnapshot {
	return { provider, status: "ok", windows: [], metrics: [], fetchedAt: now, ...fields };
}

async function getJson(ctx: UsageContext, url: string, what: string, init: RequestInit = {}): Promise<unknown> {
	const response = await ctx.fetch(url, { ...init, signal: ctx.signal });
	if (!response.ok) throw new UsageHttpError(response.status, what);
	return response.json();
}

// --- OpenAI Codex ----------------------------------------------------------------

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * `wham/usage`: two rolling windows — five hours and a week — each with how
 * much is used and when it resets, plus a credit balance on plans that have one.
 */
export function parseCodexUsage(json: unknown, now: number): OAuthUsageSnapshot {
	const root = record(json);
	const rateLimit = record(first(root, "rate_limit", "rateLimit"));
	const windows: OAuthUsageWindow[] = [];
	const pushWindow = (fallbackLabel: string, value: unknown) => {
		const window = record(value);
		if (!window) return;
		const usedPercent = clampPercent(num(first(window, "used_percent", "usedPercent")));
		const after = num(first(window, "reset_after_seconds", "resetAfterSeconds"));
		const resetsAt = timeOf(first(window, "reset_at", "resetAt")) ?? (after !== undefined && after > 0 ? now + after * 1000 : undefined);
		if (usedPercent === undefined && resetsAt === undefined) return;
		const seconds = num(first(window, "limit_window_seconds", "limitWindowSeconds"));
		windows.push({ label: seconds ? windowLabel(seconds / 60) : fallbackLabel, usedPercent, resetsAt });
	};
	pushWindow("5h", first(rateLimit, "primary_window", "primary"));
	pushWindow("Weekly", first(rateLimit, "secondary_window", "secondary"));

	const metrics: OAuthUsageMetric[] = [];
	const credits = record(root?.credits);
	const balance = num(credits?.balance);
	if (credits?.unlimited !== true && balance !== undefined && (credits?.has_credits !== false || balance > 0)) {
		metrics.push({ label: "Credits", value: balance, format: "currency", currency: "USD" });
	}
	const plan = str(first(root, "plan_type", "planType"));
	return snapshot("openai-codex", now, { windows, metrics, ...(plan ? { plan: titleCase(plan) } : {}) });
}

/** A window's length as the label people know it by: "5h", "Weekly", "30d". */
function windowLabel(minutes: number): string {
	if (Math.abs(minutes - 10_080) < 60) return "Weekly";
	if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
	if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
	return `${Math.round(minutes)}m`;
}

async function codexUsage(ctx: UsageContext): Promise<OAuthUsageSnapshot> {
	const token = await ctx.token("openai-codex");
	if (!token) return snapshot("openai-codex", ctx.now, { status: "signed-out" });
	const accountId = readCodexClaims(token).accountId;
	const json = await getJson(ctx, CODEX_USAGE_URL, "Codex 用量", {
		headers: {
			...CODEX_CLIENT_HEADERS,
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
		},
	});
	return parseCodexUsage(json, ctx.now);
}

// --- GitHub Copilot ----------------------------------------------------------------

/** What pi presents to GitHub's Copilot endpoints (`auth/oauth/github-copilot.ts`). */
const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

const COPILOT_QUOTA_LABELS: Record<string, string> = {
	premium_interactions: "Premium requests",
	chat: "Chat",
	completions: "Completions",
};

/**
 * `copilot_internal/user`. Paid plans report `quota_snapshots` — premium
 * requests being the one that runs out; the free plan reports remaining counts
 * in `limited_user_quotas` against the allowance in `monthly_quotas`.
 */
export function parseCopilotUsage(json: unknown, now: number): OAuthUsageSnapshot {
	const root = record(json);
	const resetsAt = timeOf(first(root, "quota_reset_date_utc", "quota_reset_date", "limited_user_reset_date"));
	const windows: OAuthUsageWindow[] = [];

	const snapshots = record(root?.quota_snapshots);
	if (snapshots) {
		const order = ["premium_interactions", "chat", "completions"];
		const keys = [...order.filter((key) => key in snapshots), ...Object.keys(snapshots).filter((key) => !order.includes(key))];
		for (const key of keys) {
			const quota = record(snapshots[key]);
			if (!quota) continue;
			const label = COPILOT_QUOTA_LABELS[key] ?? titleCase(key);
			if (quota.unlimited === true) {
				windows.push({ label, unlimited: true });
				continue;
			}
			const limit = num(quota.entitlement);
			const remaining = num(quota.remaining);
			const percentRemaining = num(quota.percent_remaining);
			const usedPercent = clampPercent(
				percentRemaining !== undefined
					? 100 - percentRemaining
					: limit && remaining !== undefined
						? ((limit - remaining) / limit) * 100
						: undefined,
			);
			if (usedPercent === undefined && limit === undefined) continue;
			windows.push({
				label,
				usedPercent,
				...(limit !== undefined && remaining !== undefined ? { used: Math.max(0, limit - remaining), limit } : {}),
				resetsAt,
			});
		}
	} else {
		const remaining = record(root?.limited_user_quotas);
		const monthly = record(root?.monthly_quotas);
		for (const key of ["chat", "completions"]) {
			const limit = num(monthly?.[key]);
			const left = num(remaining?.[key]);
			if (!limit || left === undefined) continue;
			const used = Math.max(0, limit - left);
			windows.push({ label: COPILOT_QUOTA_LABELS[key], used, limit, usedPercent: clampPercent((used / limit) * 100), resetsAt });
		}
	}

	const plan = str(first(root, "copilot_plan", "access_type_sku"));
	return snapshot("github-copilot", now, { windows, ...(plan ? { plan: titleCase(plan) } : {}) });
}

function hostnameOf(value: unknown): string | undefined {
	const text = str(value);
	if (!text) return undefined;
	try {
		return new URL(text.includes("://") ? text : `https://${text}`).hostname;
	} catch {
		return undefined;
	}
}

async function copilotUsage(ctx: UsageContext): Promise<OAuthUsageSnapshot> {
	// The request token is a short-lived Copilot token; the quota is read with
	// the GitHub token it was minted from, which pi keeps as the refresh token.
	const credential = await ctx.stored("github-copilot");
	const githubToken = str(credential?.refresh);
	if (!githubToken) return snapshot("github-copilot", ctx.now, { status: "signed-out" });
	const domain = hostnameOf(credential?.enterpriseUrl) ?? "github.com";
	const json = await getJson(ctx, `https://api.${domain}/copilot_internal/user`, "Copilot 额度", {
		headers: { ...COPILOT_HEADERS, Accept: "application/json", Authorization: `token ${githubToken}` },
	});
	return parseCopilotUsage(json, ctx.now);
}

// --- OpenRouter ----------------------------------------------------------------

/**
 * `/api/v1/key` describes the key signing in minted: its spend, and its cap if
 * it has one. `/api/v1/credits`, when the key may read it, adds the account's
 * remaining balance.
 */
export function parseOpenRouterUsage(key: unknown, credits: unknown, now: number): OAuthUsageSnapshot {
	const data = record(record(key)?.data) ?? record(key);
	const windows: OAuthUsageWindow[] = [];
	const metrics: OAuthUsageMetric[] = [];
	const limit = num(data?.limit);
	const usage = num(data?.usage);
	if (limit !== undefined && limit > 0) {
		const remaining = num(data?.limit_remaining);
		const used = remaining !== undefined ? Math.max(0, limit - remaining) : usage;
		const reset = str(data?.limit_reset);
		windows.push({
			label: reset ? `Key limit (${reset})` : "Key limit",
			...(used !== undefined ? { used, usedPercent: clampPercent((used / limit) * 100) } : {}),
			limit,
		});
	}
	const creditData = record(record(credits)?.data) ?? record(credits);
	const total = num(creditData?.total_credits);
	const spent = num(creditData?.total_usage);
	if (total !== undefined && spent !== undefined) {
		metrics.push({ label: "Balance", value: Math.max(0, total - spent), format: "currency", currency: "USD" });
	}
	if (usage !== undefined) metrics.push({ label: "Key spend", value: usage, format: "currency", currency: "USD" });
	const monthly = num(data?.usage_monthly);
	if (monthly !== undefined) metrics.push({ label: "This month", value: monthly, format: "currency", currency: "USD" });
	const plan = data?.is_free_tier === true ? "Free tier" : undefined;
	return snapshot("openrouter", now, { windows, metrics, ...(plan ? { plan } : {}) });
}

async function openRouterUsage(ctx: UsageContext): Promise<OAuthUsageSnapshot> {
	const token = await ctx.token("openrouter");
	if (!token) return snapshot("openrouter", ctx.now, { status: "signed-out" });
	const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
	const [key, credits] = await Promise.all([
		getJson(ctx, "https://openrouter.ai/api/v1/key", "OpenRouter Key", { headers }),
		// Readable only by some keys; the rest of the figures stand without it.
		getJson(ctx, "https://openrouter.ai/api/v1/credits", "OpenRouter 余额", { headers }).catch(() => undefined),
	]);
	return parseOpenRouterUsage(key, credits, ctx.now);
}

// --- Kimi Code ----------------------------------------------------------------

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

function kimiWindowLabel(window: Record<string, unknown> | undefined, fallback: string): string {
	const duration = num(window?.duration);
	const unit = str(first(window, "timeUnit", "time_unit"))?.toUpperCase() ?? "";
	if (!duration) return fallback;
	const minutes = unit.includes("MINUTE") ? duration : unit.includes("HOUR") ? duration * 60 : unit.includes("DAY") ? duration * 1440 : unit.includes("SECOND") ? duration / 60 : undefined;
	return minutes ? windowLabel(minutes) : fallback;
}

function kimiWindow(data: Record<string, unknown>, label: string): OAuthUsageWindow | undefined {
	const limit = num(data.limit);
	let used = num(data.used);
	const remaining = num(data.remaining);
	if (used === undefined && remaining !== undefined && limit !== undefined) used = Math.max(0, limit - remaining);
	const resetsAt = timeOf(first(data, "reset_at", "resetAt", "reset_time", "resetTime"));
	if (limit === undefined && used === undefined && resetsAt === undefined) return undefined;
	return {
		label,
		...(used !== undefined ? { used } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(used !== undefined && limit ? { usedPercent: clampPercent((used / limit) * 100) } : {}),
		...(resetsAt ? { resetsAt } : {}),
	};
}

/**
 * Kimi Code's `/usages`, read the way kimi-cli's `/usage` does: `usage` is the
 * overall (weekly) allowance, `limits` the shorter rolling windows under it.
 */
export function parseKimiUsage(json: unknown, now: number): OAuthUsageSnapshot {
	const root = record(json);
	const windows: OAuthUsageWindow[] = [];
	const usage = record(root?.usage);
	const overall = usage ? kimiWindow(usage, "Weekly") : undefined;
	if (overall) windows.push(overall);
	const limits = Array.isArray(root?.limits) ? root.limits : [];
	limits.forEach((entry, index) => {
		const item = record(entry);
		if (!item) return;
		const detail = record(item.detail) ?? item;
		const label =
			str(first(item, "name", "title", "scope")) ?? kimiWindowLabel(record(item.window), `Limit ${index + 1}`);
		const window = kimiWindow(detail, label);
		if (window) windows.push(window);
	});
	return snapshot("kimi-coding", now, { windows });
}

async function kimiUsage(ctx: UsageContext): Promise<OAuthUsageSnapshot> {
	const token = await ctx.token("kimi-coding");
	if (!token) return snapshot("kimi-coding", ctx.now, { status: "signed-out" });
	const json = await getJson(ctx, KIMI_USAGE_URL, "Kimi 用量", {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	return parseKimiUsage(json, ctx.now);
}

// --- xAI ----------------------------------------------------------------

const GROK_PROXY = "https://cli-chat-proxy.grok.com";

function grokPlanName(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const compact = raw.toLowerCase().replace(/[^a-z]/g, "");
	if (compact.includes("supergrokheavy") || compact === "heavy") return "SuperGrok Heavy";
	if (compact.includes("supergrok")) return "SuperGrok";
	return raw;
}

/**
 * The Grok CLI's billing view, as Synara reads it: one credit window — weekly
 * for unified billing, else the billing period — plus any on-demand spend.
 */
export function parseXaiBilling(billing: unknown, settings: unknown, now: number): OAuthUsageSnapshot {
	const root = record(billing);
	const config = record(root?.config) ?? root;
	const usage = record(root?.usage) ?? record(config?.usage);
	const cycle = record(root?.billingCycle) ?? record(config?.billingCycle);
	const period = record(config?.currentPeriod) ?? record(root?.currentPeriod);

	const monthlyLimit = num(first(root, "monthlyLimit")) ?? num(first(config, "monthlyLimit"));
	const totalUsed = num(usage?.totalUsed);
	const onDemandUsed = num(first(config, "onDemandUsed")) ?? num(first(root, "onDemandUsed"));
	const onDemandCap = num(first(config, "onDemandCap")) ?? num(first(root, "onDemandCap"));
	const creditPercent = num(first(config, "creditUsagePercent")) ?? num(first(root, "creditUsagePercent"));

	let usedPercent =
		creditPercent !== undefined ? clampPercent(creditPercent <= 1 ? creditPercent * 100 : creditPercent) : undefined;
	if (usedPercent === undefined && monthlyLimit && totalUsed !== undefined) usedPercent = clampPercent((totalUsed / monthlyLimit) * 100);
	if (usedPercent === undefined && onDemandCap && onDemandUsed !== undefined) usedPercent = clampPercent((onDemandUsed / onDemandCap) * 100);

	const resetsAt =
		timeOf(period?.end) ?? timeOf(config?.billingPeriodEnd) ?? timeOf(cycle?.billingPeriodEnd) ?? timeOf(root?.billingPeriodEnd);
	const periodType = str(period?.type) ?? "";
	const weekly = /weekly/i.test(periodType) || (!periodType && config?.isUnifiedBillingUser === true);

	const windows: OAuthUsageWindow[] =
		usedPercent !== undefined || resetsAt !== undefined ? [{ label: weekly ? "Weekly" : "Credits", usedPercent, resetsAt }] : [];
	const metrics: OAuthUsageMetric[] =
		onDemandCap && onDemandUsed !== undefined
			? [{ label: "On-demand", value: onDemandUsed, format: "currency", currency: "USD" }]
			: [];
	const plan = grokPlanName(str(record(settings)?.subscription_tier_display));
	return snapshot("xai", now, { windows, metrics, ...(plan ? { plan } : {}) });
}

async function xaiUsage(ctx: UsageContext): Promise<OAuthUsageSnapshot> {
	const token = await ctx.token("xai");
	if (!token) return snapshot("xai", ctx.now, { status: "signed-out" });
	const headers = { Authorization: `Bearer ${token}`, "x-xai-token-auth": "xai-grok-cli", Accept: "application/json" };
	const [billing, settings] = await Promise.all([
		getJson(ctx, `${GROK_PROXY}/v1/billing?format=credits`, "xAI 账单", { headers }),
		getJson(ctx, `${GROK_PROXY}/v1/settings`, "xAI 设置", { headers }).catch(() => undefined),
	]);
	return parseXaiBilling(billing, settings, ctx.now);
}

// --- Antigravity ----------------------------------------------------------------

/** Buckets shown at most: a long model list would bury the few that matter. */
const MAX_ANTIGRAVITY_WINDOWS = 8;

/**
 * `loadCodeAssist` names the tier and, on paid tiers, the Google One AI credit
 * balance (CLIProxyAPI's `updateAntigravityCreditsBalance`);
 * `fetchAvailableModels` carries each model's `quotaInfo` — the fraction left
 * and when it refills.
 */
export function parseAntigravityUsage(loadAssist: unknown, models: unknown, now: number): OAuthUsageSnapshot {
	const assist = record(loadAssist);
	const paid = record(assist?.paidTier);
	const current = record(assist?.currentTier);
	const plan = str(paid?.name) ?? str(current?.name) ?? str(paid?.id) ?? str(current?.id);

	const metrics: OAuthUsageMetric[] = [];
	for (const entry of Array.isArray(paid?.availableCredits) ? paid.availableCredits : []) {
		const credit = record(entry);
		if (str(credit?.creditType)?.toUpperCase() !== "GOOGLE_ONE_AI") continue;
		const amount = num(credit?.creditAmount);
		if (amount !== undefined) metrics.push({ label: "AI credits", value: amount, format: "number" });
	}

	const modelsRoot = record(models);
	const rawModels = modelsRoot?.models;
	const entries: Array<[string, Record<string, unknown>]> = Array.isArray(rawModels)
		? rawModels.flatMap((item) => {
				const model = record(item);
				return model ? [[str(first(model, "id", "name", "model")) ?? "", model] as [string, Record<string, unknown>]] : [];
			})
		: Object.entries(record(rawModels) ?? {}).flatMap(([id, value]) => {
				const model = record(value);
				return model ? [[id, model] as [string, Record<string, unknown>]] : [];
			});

	const byLabel = new Map<string, OAuthUsageWindow>();
	for (const [id, model] of entries) {
		const quota = record(first(model, "quotaInfo", "quota_info"));
		if (!quota) continue;
		const remaining = num(first(quota, "remainingFraction", "remaining_fraction"));
		const resetsAt = timeOf(first(quota, "resetTime", "reset_time"));
		if (remaining === undefined && resetsAt === undefined) continue;
		const label = str(first(model, "displayName", "display_name")) ?? id;
		if (!label) continue;
		const usedPercent = remaining !== undefined ? clampPercent(Math.round((1 - remaining) * 100)) : undefined;
		const previous = byLabel.get(label);
		// Variants of one model share a bucket; keep the most used.
		if (previous && (previous.usedPercent ?? -1) >= (usedPercent ?? -1)) continue;
		byLabel.set(label, { label, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
	}
	// The ones running out first are the ones worth seeing.
	const windows = [...byLabel.values()]
		.sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1))
		.slice(0, MAX_ANTIGRAVITY_WINDOWS);
	return snapshot("antigravity", now, { windows, metrics, ...(plan ? { plan } : {}) });
}

async function antigravityUsage(ctx: UsageContext): Promise<OAuthUsageSnapshot> {
	if (!ctx.antigravity) return snapshot("antigravity", ctx.now, { status: "signed-out" });
	const loadAssist = await ctx.antigravity("loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } });
	// The project is attached by the service; a failure here still leaves the tier and credits.
	const models = await ctx.antigravity("fetchAvailableModels", {}).catch(() => undefined);
	return parseAntigravityUsage(loadAssist, models, ctx.now);
}

// --- dispatch ----------------------------------------------------------------

const FETCHERS: Partial<Record<OAuthProviderId, (ctx: UsageContext) => Promise<OAuthUsageSnapshot>>> = {
	"openai-codex": codexUsage,
	"github-copilot": copilotUsage,
	openrouter: openRouterUsage,
	"kimi-coding": kimiUsage,
	xai: xaiUsage,
	antigravity: antigravityUsage,
};

const UNSUPPORTED_MESSAGES: Partial<Record<OAuthProviderId, string>> = {
	radius: "Radius 网关没有提供额度查询接口，可用额度以网关返回的错误为准。",
};

/** Ask one provider. Never throws: a failure is a snapshot that says so. */
export async function fetchOAuthUsage(provider: OAuthProviderId, ctx: UsageContext): Promise<OAuthUsageSnapshot> {
	const fetcher = FETCHERS[provider];
	if (!fetcher) {
		return snapshot(provider, ctx.now, {
			status: "unsupported",
			message: UNSUPPORTED_MESSAGES[provider] ?? "该供应商没有提供额度查询接口。",
		});
	}
	try {
		const result = await fetcher(ctx);
		if (result.status === "ok" && result.windows.length === 0 && result.metrics.length === 0 && !result.message) {
			return { ...result, message: "供应商没有返回额度信息。" };
		}
		return result;
	} catch (error) {
		const message =
			error instanceof UsageHttpError && (error.status === 401 || error.status === 403)
				? `${error.message}：登录可能已失效，或该账号无权查询额度。`
				: error instanceof Error
					? error.message
					: String(error);
		return snapshot(provider, ctx.now, { status: "error", message });
	}
}
