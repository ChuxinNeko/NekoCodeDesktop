import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type {
	OAuthLoginEvent,
	OAuthProviderId,
	OAuthProviderSummary,
} from "../shared/settings";
import { CODEX_CLIENT_HEADERS, readCodexClaims } from "./openai-codex";
import { ANTIGRAVITY_SIGNED_OUT, type AntigravityOAuthService } from "./antigravity-oauth-service";

/** One OAuth provider this app can sign into. */
interface OAuthProviderDef {
	id: OAuthProviderId;
	/** The id the agent core registers the provider — and stores the token — under. */
	providerId: string;
	name: string;
	/** Client identity pinned onto the provider before any request goes out. */
	headers: Record<string, string>;
	/** The login method id to answer the core's method prompt with. */
	loginMethod: string;
}

export const OAUTH_PROVIDERS: OAuthProviderDef[] = [
	{
		id: "openai-codex",
		providerId: "openai-codex",
		name: "OpenAI (ChatGPT)",
		headers: CODEX_CLIENT_HEADERS,
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
		try {
			runtime.registerProvider(def.providerId, { headers: def.headers });
		} catch (error) {
			// A provider this core build does not know is not worth failing startup
			// for; it simply cannot be signed into.
			console.error(`oauth: failed to pin client identity for ${def.providerId}:`, error);
		}
	}
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

	constructor(
		private readonly options: {
			userDataDir: string;
			getRuntime: () => Promise<ModelRuntime>;
			/** Opens the sign-in page in the user's real browser. */
			openExternal: (url: string) => void;
			emit: (event: OAuthLoginEvent) => void;
			antigravity?: AntigravityOAuthService;
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
		const signedIn = runtime.getProviderAuthStatus(def.providerId).configured;
		return {
			id: def.id,
			providerId: def.providerId,
			name: def.name,
			signedIn,
			// Details describe the signed-in account; a signed-out row shows none.
			...(signedIn ? account : {}),
			modelIds: runtime.getModels(def.providerId).map((model) => model.id),
		};
	}

	private def(id: OAuthProviderId): OAuthProviderDef {
		const found = OAUTH_PROVIDERS.find((entry) => entry.id === id);
		if (!found) throw new Error(`Unknown OAuth provider: ${id}`);
		return found;
	}

	/** Drive one sign-in. Progress is reported through `emit`; so is the outcome. */
	async login(id: string): Promise<OAuthProviderSummary> {
		if (id === "antigravity") {
			if (!this.options.antigravity) throw new Error("Antigravity OAuth service unavailable");
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
				if (event.type === "progress" || event.type === "info") {
					this.options.emit({ kind: "progress", provider: id, message: event.message });
				}
			},
			prompt: (prompt: AuthPrompt) => {
				if (prompt.type === "select") {
					return Promise.resolve(def.loginMethod);
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
			const account: CachedAccount =
				credential.type === "oauth"
					? { ...readCodexClaims(credential.access), signedInAt: Date.now() }
					: { signedInAt: Date.now() };
			// The token's own expiry beats the claim when both are present: the core
			// refreshes against it.
			if (credential.type === "oauth" && typeof credential.expires === "number") {
				account.expiresAt = credential.expires;
			}
			this.persist({ ...this.load(), [id]: account });
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
			return this.options.antigravity.logout();
		}
		if (!isOAuthProviderId(id)) throw new Error(`Unknown OAuth provider: ${id}`);
		const def = this.def(id);
		const runtime = await this.options.getRuntime();
		await runtime.logout(def.providerId);
		const next = { ...this.load() };
		delete next[id];
		this.persist(next);
		return this.summarize(runtime, def, undefined);
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
