import type { ThinkingLevel } from "./agent";

export type ModelApiProtocol =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages";

/**
 * How a provider is reached. `custom-api` is an endpoint plus a key the user
 * pastes in. `oauth` is a subscription signed into through the provider's own
 * browser flow. Credentials live in the core's store or the app's encrypted
 * OAuth store, never in the custom API profile file.
 */
export type ProviderKind = "custom-api" | "oauth";

/** An OAuth-backed provider this app knows how to sign into. */
export type OAuthProviderId =
	| "openai-codex"
	| "github-copilot"
	| "openrouter"
	| "kimi-coding"
	| "xai"
	| "radius"
	| "antigravity";

/** What a sign-in needs to know before it starts; only some providers ask. */
export interface OAuthLoginOptions {
	/** GitHub Enterprise domain for Copilot; blank signs into github.com. */
	enterpriseDomain?: string;
}

/**
 * Non-secret account state for settings. Token values never cross IPC.
 */
export interface OAuthProviderSummary {
	id: OAuthProviderId;
	/** The id the agent core stores the credential under. */
	providerId: string;
	name: string;
	signedIn: boolean;
	accountId?: string;
	projectId?: string;
	email?: string;
	/** ChatGPT plan the token reports: "plus", "pro", "team", … */
	plan?: string;
	/** When the access token expires. */
	expiresAt?: number;
	signedInAt?: number;
	/** Empty for providers whose current integration is login-only. */
	modelIds: string[];
	/** The imported models with their catalog limits — read-only; a
	 *  subscription's real ceilings are the provider's to decide. */
	models: OAuthModelSummary[];
}

/**
 * One limit a subscription counts against — a rolling window, a monthly
 * allowance, a per-model bucket. Shaped after CLIProxyAPI's normalized quota
 * bucket, but carried as used-percent — what providers report; the settings
 * page turns it around and shows what is left.
 */
export interface OAuthUsageWindow {
	/** "5h", "Weekly", "Premium requests", a model name, … */
	label: string;
	/** 0–100. Absent when the provider reports only counts, or only a reset. */
	usedPercent?: number;
	/** Counts, when the provider gives them: `used` of `limit`. */
	used?: number;
	limit?: number;
	/** No ceiling on this one; the bar has nothing to fill. */
	unlimited?: boolean;
	/** When it resets, epoch ms. */
	resetsAt?: number;
}

/** A single account figure, after CLIProxyAPI's QuotaMetric: a balance, a spend, a credit count. */
export interface OAuthUsageMetric {
	label: string;
	value: number;
	format: "number" | "currency";
	/** ISO 4217, for `currency`. */
	currency?: string;
}

/** What one subscription reports about its own allowance, as of `fetchedAt`. */
export interface OAuthUsageSnapshot {
	provider: OAuthProviderId;
	/**
	 * `ok`: the provider answered. `unsupported`: it has no way to ask.
	 * `signed-out`: nothing to ask with. `error`: it was asked and failed.
	 */
	status: "ok" | "unsupported" | "signed-out" | "error";
	plan?: string;
	windows: OAuthUsageWindow[];
	metrics: OAuthUsageMetric[];
	/** Why it is not `ok`, or a caveat about what is shown. */
	message?: string;
	fetchedAt: number;
}

/**
 * What a sign-in run reports back. The browser flow is out-of-process, so the
 * UI follows it through these rather than a single promise.
 */
export type OAuthLoginEvent =
	| { kind: "url"; provider: OAuthProviderId; url: string }
	/** A device-code flow: the user enters `userCode` at `verificationUri`, on any device. */
	| {
			kind: "device-code";
			provider: OAuthProviderId;
			userCode: string;
			verificationUri: string;
			/** When the code stops working. */
			expiresAt?: number;
	  }
	| { kind: "progress"; provider: OAuthProviderId; message: string }
	/** The callback port is unusable; the code has to be pasted in by hand. */
	| { kind: "manual-code"; provider: OAuthProviderId; message: string }
	| { kind: "done"; provider: OAuthProviderId; account: OAuthProviderSummary }
	| { kind: "error"; provider: OAuthProviderId; message: string }
	| { kind: "cancelled"; provider: OAuthProviderId };

/**
 * Token limits for a custom endpoint, which does not advertise its own.
 *
 * The output ceiling is what decides whether a model can finish a `write` call
 * in one response: a response truncated by the limit has all of its tool calls
 * rejected, because salvaged JSON arguments parse but carry half a file. The
 * defaults stay conservative because a `max_tokens` above what the endpoint
 * accepts fails every request outright, which is worse than truncation — a
 * profile that knows its model's real ceiling raises them itself.
 */
export const DEFAULT_CONTEXT_WINDOW = 256_000;
export const DEFAULT_MAX_TOKENS = 32_768;
export const MIN_TOKEN_LIMIT = 1_024;
export const MAX_CONTEXT_WINDOW = 10_000_000;
export const MAX_OUTPUT_TOKENS = 1_000_000;

export interface ModelTokenLimits {
	contextWindow: number;
	maxTokens: number;
}

export interface OAuthModelSummary extends ModelTokenLimits {
	id: string;
	name: string;
}

export interface ModelProfileSummary {
	id: string;
	kind: ProviderKind;
	name: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	modelIds: string[];
	/** The endpoint serves reasoning models, so thinking levels apply to them. */
	reasoning: boolean;
	imageInput: boolean;
	/** Always resolved: a profile that stored no override reports the default. */
	contextWindow: number;
	/**
	 * Output ceiling for one response. Too low and a long `write` is truncated
	 * mid-argument and rejected; above what the endpoint accepts, every request
	 * fails outright — so it follows the model, not the file being edited.
	 */
	maxTokens: number;
	/** Explicit per-model ceilings only; a model without an entry inherits
	 *  this profile's `contextWindow`/`maxTokens`. */
	modelOverrides: Record<string, ModelTokenLimits>;
	/**
	 * Thinking levels a model supports, where the user set them; a model
	 * without an entry follows the profile's `reasoning` switch.
	 */
	modelThinking: Record<string, ThinkingLevel[]>;
	hasApiKey: boolean;
	createdAt: number;
	updatedAt: number;
}

/**
 * The proxy the app's own requests go through.
 *
 * The agent core reaches providers with the runtime's `fetch`, which ignores
 * the operating system's proxy settings, so this is what stands between a
 * proxied network and every request failing at the transport layer.
 */
export interface ProxyStatus {
	/** The override in effect; `null` means the environment and system decide. */
	manual: string | null;
	/** Where the proxy in use came from. */
	source: "manual" | "environment" | "system" | "none";
	/** The proxy actually installed, absent when connecting directly. */
	url?: string;
	/** A configured proxy that could not be used, and why. */
	warning?: string;
}

export interface ModelStoreStatus {
	encryptionAvailable: boolean;
	backend: string;
	warning?: string;
}

export interface SaveModelProfileRequest {
	id?: string;
	/** Defaults to `custom-api`; anything else is rejected until it is built. */
	kind?: ProviderKind;
	name: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	apiKey?: string;
	/** May be empty: a provider is saved before its models are picked. */
	modelIds: string[];
	reasoning?: boolean;
	imageInput?: boolean;
	/** Omitted keeps the stored value; the store's default applies if unset. */
	contextWindow?: number;
	maxTokens?: number;
	/** Omitted keeps the stored overrides; keys outside `modelIds` are dropped. */
	modelOverrides?: Record<string, ModelTokenLimits>;
	/** Omitted keeps the stored levels; keys outside `modelIds` are dropped. */
	modelThinking?: Record<string, ThinkingLevel[]>;
}

export interface FetchModelsRequest {
	profileId?: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	apiKey?: string;
}

export interface FetchedModel {
	id: string;
	name: string;
}

export interface ModelTestRequest {
	profileId: string;
	modelId: string;
}

export interface ModelTestResult {
	ok: boolean;
	latencyMs: number;
	message: string;
	output?: string;
}

/** Every thinking level, weakest first — the order pi clamps through. */
export const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * What a model offers without levels of its own: off only, or — on an endpoint
 * marked as reasoning — off through high. xhigh and max are never assumed:
 * a model that does not know them rejects the request outright.
 */
export function defaultThinkingLevels(reasoning: boolean): ThinkingLevel[] {
	return reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"];
}

/** A set of levels in order, each once; null when it is not a usable set. */
export function normalizeThinkingLevels(levels: unknown): ThinkingLevel[] | null {
	if (!Array.isArray(levels) || levels.length === 0) return null;
	if (!levels.every((level) => (THINKING_LEVEL_ORDER as readonly unknown[]).includes(level))) return null;
	return THINKING_LEVEL_ORDER.filter((level) => levels.includes(level));
}

/** The levels a model offers: its own, else the endpoint's default. */
export function effectiveThinkingLevels(
	profile: Pick<ModelProfileSummary, "reasoning" | "modelThinking">,
	modelId: string,
): ThinkingLevel[] {
	return profile.modelThinking?.[modelId] ?? defaultThinkingLevels(profile.reasoning);
}
