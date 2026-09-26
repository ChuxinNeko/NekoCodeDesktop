import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type {
	OAuthLoginEvent,
	OAuthLoginOptions,
	OAuthProviderId,
	OAuthProviderSummary,
	OAuthUsageSnapshot,
} from "../shared/settings";
import { fetchOAuthUsage, type FetchLike } from "./oauth-usage";
import { pi } from "./pi";
import { CODEX_CLIENT_HEADERS, readCodexClaims } from "./openai-codex";
import { ANTIGRAVITY_SIGNED_OUT, type AntigravityOAuthService } from "./antigravity-oauth-service";

/** One OAuth provider this app can sign into. */
interface OAuthProviderDef {
	id: OAuthProviderId;
	/** The id the agent core registers the provider — and stores the token — under. */
	providerId: string;
	name: string;
	/** Client identity pinned onto the provider before any request goes out. */
	headers?: Record<string, string>;
	/** The login method id to answer the core's method prompt with, for flows that offer several. */
	loginMethod?: string;
	/**
	 * The answer to a flow's free-text question. Only Copilot asks one — which
	 * GitHub to sign into — and the form collects it before the flow starts.
	 */
	textAnswer?: (options: OAuthLoginOptions) => string;
}

/**
 * The subscriptions signed into through pi's own flows. Every one of them is a
 * provider pi already ships, so once signed in its models reach the picker
 * through the runtime like any other; nothing here describes a model.
 */
export const OAUTH_PROVIDERS: OAuthProviderDef[] = [
	{
		id: "openai-codex",
		providerId: "openai-codex",
		name: "OpenAI (ChatGPT)",
		headers: CODEX_CLIENT_HEADERS,
		loginMethod: "browser",
	},
	{
		id: "github-copilot",
		providerId: "github-copilot",
		name: "GitHub Copilot",
		textAnswer: (options) => options.enterpriseDomain?.trim() ?? "",
	},
	{
		// Signing in mints an ordinary OpenRouter API key, kept like a token.
		id: "openrouter",
		providerId: "openrouter",
		name: "OpenRouter",
	},
	{
		id: "kimi-coding",
		providerId: "kimi-coding",
		name: "Kimi Code",
	},
	{
		id: "xai",
		providerId: "xai",
		name: "xAI (Grok)",
	},
	{
		// pi's hosted gateway at radius.pi.dev; the browser flow is the one it recommends.
		id: "radius",
		providerId: "radius",
		name: "Radius (pi)",
		loginMethod: "browser",
	},
];

/**
 * Pin the client identity onto every OAuth provider.
 *
 * Called the moment the model runtime exists, before it can serve a request:
 * the identity is not a display detail, it is what the Codex backend sees, so a
 * single unpinned request is a request too many. Re-registering merges over the
 * previous registration, so calling this again is harmless.
 */
export function registerOAuthClientIdentity(runtime: ModelRuntime): void {
	for (const def of OAUTH_PROVIDERS) {
		// Only a provider with an identity to present is re-registered; the rest
		// are pi's own and need nothing layered over them.
		if (!def.headers) continue;
		try {
			runtime.registerProvider(def.providerId, { headers: def.headers });
		} catch (error) {
			// A provider this core build does not know is not worth failing startup
			// for; it simply cannot be signed into.
			console.error(`oauth: failed to pin client identity for ${def.providerId}:`, error);
		}
	}
}

/**
 * Options as they arrive over IPC, reduced to what a sign-in may use. A domain
 * is a hostname and at most a path — nothing that could smuggle a second value
 * into the flow's prompt.
 */
export function oauthLoginOptions(raw: unknown): OAuthLoginOptions {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const domain = (raw as Record<string, unknown>).enterpriseDomain;
	if (typeof domain !== "string") return {};
	const trimmed = domain.trim();
	if (!trimmed || trimmed.length > 253 || /\s/.test(trimmed)) return {};
	return { enterpriseDomain: trimmed };
}

/** Non-secret account details, cached so a row can name the signed-in account. */
interface CachedAccount {
	accountId?: string;
	email?: string;
	plan?: string;
	expiresAt?: number;
	signedInAt?: number;
}

type AccountFile = Partial<Record<OAuthProviderId, CachedAccount>>;

function isOAuthProviderId(value: string): value is OAuthProviderId {
	return OAUTH_PROVIDERS.some((entry) => entry.id === value);
}

/** A quota read is reused this long: opening settings twice should not ask twice. */
const USAGE_TTL_MS = 60_000;
const USAGE_TIMEOUT_MS = 20_000;

async function piReadStoredCredential(providerId: string): Promise<Record<string, unknown> | undefined> {
	const { readStoredCredential } = await pi();
	return readStoredCredential(providerId) as Record<string, unknown> | undefined;
}

/**
 * Signs providers in through the agent core's own OAuth flows.
 *
 * The token is deliberately not this app's to hold: the core owns the
 * credential store, the locked refresh, and the request path that spends it, so
 * signing in here means driving its flow and showing what it reports. What this
 * app does own is the client identity presented upstream — pinned onto the
 * provider before the first request — and a cache of the non-secret account
 * details, because the core exposes whether a provider is configured but not
 * which account configured it.
 */
export class OAuthService {
	private readonly filePath: string;
	private accounts: AccountFile | null = null;
	private pending = new Map<OAuthProviderId, { abort: AbortController; code?: (value: string) => void }>();
	private usageCache = new Map<OAuthProviderId, { at: number; value: Promise<OAuthUsageSnapshot> }>();

	constructor(
		private readonly options: {
			userDataDir: string;
			getRuntime: () => Promise<ModelRuntime>;
			/** Opens the sign-in page in the user's real browser. */
			openExternal: (url: string) => void;
			emit: (event: OAuthLoginEvent) => void;
			antigravity?: AntigravityOAuthService;
			/** Injectable for tests; the global fetch goes through the app's proxy. */
			fetch?: FetchLike;
			/** pi's stored credential for a provider; injectable for tests. */
			readStored?: (providerId: string) => Promise<Record<string, unknown> | undefined>;
		},
	) {
		this.filePath = join(options.userDataDir, "oauth-accounts.json");
	}

	private load(): AccountFile {
		if (this.accounts) return this.accounts;
		if (!existsSync(this.filePath)) {
			this.accounts = {};
			return this.accounts;
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
			this.accounts =
				typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as AccountFile) : {};
		} catch {
			// A damaged cache costs a display name, nothing more — start over.
			this.accounts = {};
		}
		return this.accounts;
	}

	private persist(next: AccountFile): void {
		mkdirSync(this.options.userDataDir, { recursive: true });
		const tmp = `${this.filePath}.tmp-${process.pid}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, this.filePath);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// best-effort cleanup of our own temp file
			}
			throw error;
		}
		this.accounts = next;
	}

	async list(): Promise<OAuthProviderSummary[]> {
		const runtime = await this.options.getRuntime();
		const cache = this.load();
		return [
			...OAUTH_PROVIDERS.map((def) => this.summarize(runtime, def, cache[def.id])),
			this.options.antigravity?.list() ?? { ...ANTIGRAVITY_SIGNED_OUT },
		];
	}

	private summarize(
		runtime: ModelRuntime,
		def: OAuthProviderDef,
		account: CachedAccount | undefined,
	): OAuthProviderSummary {
		// Only a stored credential is a sign-in: OpenRouter, xAI and Kimi also take
		// a key from the environment, and that is not an account to sign out of.
		const status = runtime.getProviderAuthStatus(def.providerId);
		const signedIn = status.configured && status.source === "stored";
		const models = runtime.getModels(def.providerId).map((model) => ({
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
		return {
			id: def.id,
			providerId: def.providerId,
			name: def.name,
			signedIn,
			// Details describe the signed-in account; a signed-out row shows none.
			...(signedIn ? account : {}),
			modelIds: models.map((model) => model.id),
			models,
		};
	}

	private def(id: OAuthProviderId): OAuthProviderDef {
		const found = OAUTH_PROVIDERS.find((entry) => entry.id === id);
		if (!found) throw new Error(`Unknown OAuth provider: ${id}`);
		return found;
	}

	/** Drive one sign-in. Progress is reported through `emit`; so is the outcome. */
	async login(id: string, options: OAuthLoginOptions = {}): Promise<OAuthProviderSummary> {
		if (id === "antigravity") {
			if (!this.options.antigravity) throw new Error("Antigravity OAuth service unavailable");
			this.usageCache.delete("antigravity");
			return this.options.antigravity.login();
		}
		if (!isOAuthProviderId(id)) throw new Error(`Unknown OAuth provider: ${id}`);
		if (this.pending.has(id)) throw new Error("该供应商正在登录中");
		const def = this.def(id);
		const abort = new AbortController();
		const entry: { abort: AbortController; code?: (value: string) => void } = { abort };
		// Claimed before the first await: two sign-ins for one provider would race
		// for the same callback port and the same credential slot.
		this.pending.set(id, entry);

		const interaction: AuthInteraction = {
			signal: abort.signal,
			notify: (event: AuthEvent) => {
				if (event.type === "auth_url") {
					this.options.openExternal(event.url);
					this.options.emit({ kind: "url", provider: id, url: event.url });
					return;
				}
				if (event.type === "device_code") {
					// Not opened for the user: the page shows the code first, and
					// opens the address once they have it to type in.
					this.options.emit({
						kind: "device-code",
						provider: id,
						userCode: event.userCode,
						verificationUri: event.verificationUri,
						...(event.expiresInSeconds ? { expiresAt: Date.now() + event.expiresInSeconds * 1000 } : {}),
					});
					return;
				}
				if (event.type === "progress" || event.type === "info") {
					this.options.emit({ kind: "progress", provider: id, message: event.message });
				}
			},
			prompt: (prompt: AuthPrompt) => {
				if (prompt.type === "select") {
					const method = def.loginMethod ?? prompt.options[0]?.id;
					if (!method || !prompt.options.some((option) => option.id === method)) {
						return Promise.reject(new Error(`Unsupported login method for ${def.name}`));
					}
					return Promise.resolve(method);
				}
				if (prompt.type === "text" && def.textAnswer) {
					return Promise.resolve(def.textAnswer(options));
				}
				if (prompt.type === "manual_code") {
					// The core always raises this alongside the callback server and
					// takes whichever answers first, so it is a fallback, not a step:
					// it resolves only if the user actually pastes something.
					this.options.emit({ kind: "manual-code", provider: id, message: prompt.message });
					return new Promise<string>((resolve, reject) => {
						entry.code = resolve;
						const onAbort = () => reject(new Error("Login cancelled"));
						prompt.signal?.addEventListener("abort", onAbort, { once: true });
						abort.signal.addEventListener("abort", onAbort, { once: true });
					});
				}
				return Promise.reject(new Error(`Unsupported login prompt: ${prompt.type}`));
			},
		};

		try {
			const runtime = await this.options.getRuntime();
			const credential = await runtime.login(def.providerId, "oauth", interaction);
			// The claims reader is a plain JWT decode: it finds the email on any
			// provider's token that carries one, and nothing on one that is not a JWT.
			const account: CachedAccount =
				credential.type === "oauth"
					? { ...readCodexClaims(credential.access), signedInAt: Date.now() }
					: { signedInAt: Date.now() };
			// The token's own expiry beats the claim when both are present: the core
			// refreshes against it. A key that never expires (OpenRouter's) has none.
			if (credential.type === "oauth" && typeof credential.expires === "number") {
				if (credential.expires < Number.MAX_SAFE_INTEGER) account.expiresAt = credential.expires;
				else delete account.expiresAt;
			}
			if (id === "github-copilot" && options.enterpriseDomain?.trim()) {
				account.accountId = options.enterpriseDomain.trim();
			}
			this.persist({ ...this.load(), [id]: account });
			// Another account's quota, or none read yet: either way not this one's.
			this.usageCache.delete(id);
			const summary = this.summarize(runtime, def, account);
			this.options.emit({ kind: "done", provider: id, account: summary });
			return summary;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (abort.signal.aborted) {
				this.options.emit({ kind: "cancelled", provider: id });
			} else {
				this.options.emit({ kind: "error", provider: id, message });
			}
			throw error;
		} finally {
			this.pending.delete(id);
		}
	}

	cancel(id: string): void {
		if (id === "antigravity") { this.options.antigravity?.cancel(); return; }
		if (!isOAuthProviderId(id)) return;
		this.pending.get(id)?.abort.abort();
	}

	/** Hand the flow a code pasted by hand when the callback cannot be received. */
	submitCode(id: string, code: string): void {
		if (id === "antigravity") { this.options.antigravity?.submitCode(code); return; }
		if (!isOAuthProviderId(id)) return;
		const trimmed = code.trim();
		if (!trimmed) return;
		this.pending.get(id)?.code?.(trimmed);
	}

	async logout(id: string): Promise<OAuthProviderSummary> {
		if (id === "antigravity") {
			if (!this.options.antigravity) throw new Error("Antigravity OAuth service unavailable");
			this.usageCache.delete("antigravity");
			return this.options.antigravity.logout();
		}
		if (!isOAuthProviderId(id)) throw new Error(`Unknown OAuth provider: ${id}`);
		const def = this.def(id);
		const runtime = await this.options.getRuntime();
		await runtime.logout(def.providerId);
		const next = { ...this.load() };
		delete next[id];
		this.persist(next);
		this.usageCache.delete(id);
		return this.summarize(runtime, def, undefined);
	}

	/**
	 * How much of a subscription is left. Cached briefly per provider; `force`
	 * asks again. Never rejects for a provider-side failure — the snapshot
	 * carries it — so one broken endpoint cannot blank the whole page.
	 */
	usage(id: string, force = false): Promise<OAuthUsageSnapshot> {
		if (id !== "antigravity" && !isOAuthProviderId(id)) return Promise.reject(new Error(`Unknown OAuth provider: ${id}`));
		const provider = id as OAuthProviderId;
		const cached = this.usageCache.get(provider);
		if (!force && cached && Date.now() - cached.at < USAGE_TTL_MS) return cached.value;
		const value = this.readUsage(provider);
		this.usageCache.set(provider, { at: Date.now(), value });
		// A read that failed outright is not worth keeping for a minute.
		value.then((result) => {
			if (result.status === "error" && this.usageCache.get(provider)?.value === value) this.usageCache.delete(provider);
		});
		return value;
	}

	private async readUsage(provider: OAuthProviderId): Promise<OAuthUsageSnapshot> {
		const now = Date.now();
		const signal = AbortSignal.timeout(USAGE_TIMEOUT_MS);
		const antigravity = this.options.antigravity;
		if (provider === "antigravity") {
			if (!antigravity?.list().signedIn) return { provider, status: "signed-out", windows: [], metrics: [], fetchedAt: now };
		} else {
			const runtime = await this.options.getRuntime();
			const status = runtime.getProviderAuthStatus(this.def(provider).providerId);
			if (!(status.configured && status.source === "stored")) {
				return { provider, status: "signed-out", windows: [], metrics: [], fetchedAt: now };
			}
		}
		return fetchOAuthUsage(provider, {
			now,
			signal,
			fetch: this.options.fetch ?? globalThis.fetch,
			token: async (providerId) => {
				const runtime = await this.options.getRuntime();
				const auth = await runtime.getAuth(providerId);
				return auth?.auth.apiKey;
			},
			stored: (providerId) => (this.options.readStored ?? piReadStoredCredential)(providerId),
			...(antigravity ? { antigravity: (method, body) => antigravity.cloudCode(method, body, signal) } : {}),
		});
	}

	async refresh(id: string): Promise<OAuthProviderSummary> {
		if (id !== "antigravity" || !this.options.antigravity) throw new Error("Unsupported OAuth refresh provider");
		return this.options.antigravity.refresh();
	}

	close(): void {
		for (const pending of this.pending.values()) pending.abort.abort();
		this.options.antigravity?.close();
	}
}
