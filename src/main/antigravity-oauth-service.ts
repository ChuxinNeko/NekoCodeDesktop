import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthLoginEvent, OAuthProviderSummary } from "../shared/settings";
import {
	ANTIGRAVITY_CALLBACK_PORT, ANTIGRAVITY_REDIRECT_URI, buildAuthUrl,
	exchangeCode, fetchUserEmail, refreshTokens, resolveProject, fetchAntigravityIdentity, type AntigravityIdentity, type FetchLike,
} from "./antigravity";
import { startCallbackServer, type CallbackServer } from "./oauth-callback-server";
import type { OAuthCredentialStore, StoredOAuthCredential } from "./oauth-credential-store";
import { ANTIGRAVITY_CATALOG } from "./antigravity-catalog";

export interface AntigravityRequestContext {
	accessToken: string; projectId: string; scope: string; identity: AntigravityIdentity; signal: AbortSignal;
}

export const ANTIGRAVITY_SIGNED_OUT: OAuthProviderSummary = {
	id: "antigravity", providerId: "antigravity", name: "Antigravity (Google)", signedIn: false, modelIds: [], models: [],
};

/** Owns the encrypted account and the lifetime of requests using it. */
export class AntigravityOAuthService {
	private pending?: { abort: AbortController; server?: CallbackServer };
	private refreshing?: Promise<StoredOAuthCredential>;
	private refreshAbort?: AbortController;
	private generation = 0;
	private identity?: { value: AntigravityIdentity; expires: number };
	private requests = new AbortController();

	constructor(private readonly options: {
		store: Pick<OAuthCredentialStore, "account" | "read" | "write" | "delete" | "has" | "assertEncryptionAvailable">;
		fetch: FetchLike;
		openExternal: (url: string) => void | Promise<void>;
		emit: (event: OAuthLoginEvent) => void;
		startCallback?: typeof startCallbackServer;
		loginTimeoutMs?: number;
	}) {}

	list(): OAuthProviderSummary {
		const account = this.options.store.account("antigravity");
		const models = account
			? ANTIGRAVITY_CATALOG.map((model) => ({
					id: model.id,
					name: model.name,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				}))
			: [];
		return {
			...ANTIGRAVITY_SIGNED_OUT,
			...(account ? {
				signedIn: true, email: account.email, projectId: account.projectId,
				expiresAt: account.expiresAt, signedInAt: account.signedInAt,
				modelIds: models.map((model) => model.id),
				models,
			} : {}),
		};
	}

	async login(): Promise<OAuthProviderSummary> {
		if (this.pending) throw new Error("Antigravity 正在登录中");
		const pending = { abort: new AbortController() } as NonNullable<AntigravityOAuthService["pending"]>;
		this.pending = pending;
		const timeout = setTimeout(() => pending.abort.abort(new Error("Antigravity 登录超时，请重新登录")), this.options.loginTimeoutMs ?? 300_000);
		const signal = pending.abort.signal;
		const onAbort = () => pending.server?.cancel();
		signal.addEventListener("abort", onAbort, { once: true });
		const fetch: FetchLike = (input, init) => {
			signal.throwIfAborted();
			return this.options.fetch(input, { ...init, signal: AbortSignal.any([signal, init?.signal ?? AbortSignal.timeout(30_000)]) });
		};
		let manualTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			// Fail before opening consent if the credential cannot be stored securely.
			this.options.store.assertEncryptionAvailable();
			const state = randomBytes(16).toString("hex");
			pending.server = await (this.options.startCallback ?? startCallbackServer)({
				port: ANTIGRAVITY_CALLBACK_PORT, path: "/oauth-callback", state,
			});
			signal.throwIfAborted();
			const url = buildAuthUrl(state);
			this.options.emit({ kind: "url", provider: "antigravity", url });
			try { await this.options.openExternal(url); }
			catch { this.options.emit({ kind: "progress", provider: "antigravity", message: "无法自动打开浏览器，请手动打开上方授权链接" }); }
			manualTimer = setTimeout(() => this.options.emit({ kind: "manual-code", provider: "antigravity", message: "请粘贴包含 code 和 state 的完整回调 URL" }), 15_000);
			const code = await pending.server.waitForCode();
			clearTimeout(manualTimer);
			signal.throwIfAborted();
			if (!code) throw new Error("Antigravity 授权未完成或已被拒绝");
			pending.server.close();
			this.options.emit({ kind: "progress", provider: "antigravity", message: "正在验证授权并获取账号信息…" });
			const tokens = await exchangeCode(code, ANTIGRAVITY_REDIRECT_URI, fetch);
			if (!this.identity || this.identity.expires <= Date.now()) {
				this.identity = { value: await fetchAntigravityIdentity(fetch), expires: Date.now() + 6 * 60 * 60 * 1000 };
			}
			const email = await fetchUserEmail(tokens.accessToken, fetch, this.identity.value);
			const project = await resolveProject(tokens.accessToken, fetch, (ms) => delay(ms, undefined, { signal }), this.identity.value);
			signal.throwIfAborted();
			// Invalidate an older account's in-flight refresh before the atomic commit.
			this.generation++;
			this.requests.abort(); this.requests = new AbortController();
			this.refreshAbort?.abort();
			this.refreshing = undefined;
			this.options.store.write("antigravity", tokens, { email, ...project, signedInAt: Date.now() });
			const account = this.list();
			this.options.emit({ kind: "done", provider: "antigravity", account });
			return account;
		} catch (error) {
			const message = signal.aborted ? String(signal.reason?.message ?? "登录已取消") : error instanceof Error ? error.message : String(error);
			this.options.emit(signal.aborted && signal.reason?.name === "AbortError"
				? { kind: "cancelled", provider: "antigravity" }
				: { kind: "error", provider: "antigravity", message });
			throw new Error(message);
		} finally {
			clearTimeout(timeout);
			clearTimeout(manualTimer);
			signal.removeEventListener("abort", onAbort);
			pending.server?.close();
			this.pending = undefined;
		}
	}

	submitCode(input: string): void {
		try { this.pending?.server?.submit(input); }
		catch (error) {
			// An invalid paste must not terminate a still-valid browser callback.
			this.options.emit({ kind: "progress", provider: "antigravity", message: error instanceof Error ? error.message : "回调地址无效" });
		}
	}

	cancel(): void { this.pending?.abort.abort(); }

	/** One refresh per account, five minutes before expiry (executor safety window). */
	getValidCredential(): Promise<StoredOAuthCredential> {
		if (this.refreshing) return this.refreshing;
		const credential = this.options.store.read("antigravity");
		const account = this.options.store.account("antigravity");
		if (!credential || !account) return Promise.reject(new Error("请先登录 Antigravity"));
		if (credential.expiresAt > Date.now() + 300_000) return Promise.resolve(credential);
		const generation = this.generation;
		const abort = new AbortController();
		this.refreshAbort = abort;
		const fetch: FetchLike = (input, init) => this.options.fetch(input, {
			...init, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
		});
		const refreshing = refreshTokens(credential.refreshToken, fetch).then((next) => {
			abort.signal.throwIfAborted();
			if (generation !== this.generation) throw new Error("登录状态已变更，请重试");
			this.options.store.write("antigravity", next, account);
			return next;
		}).finally(() => {
			if (this.refreshing === refreshing) { this.refreshing = undefined; this.refreshAbort = undefined; }
		});
		this.refreshing = refreshing;
		return refreshing;
	}

	async refresh(): Promise<OAuthProviderSummary> {
		await this.getValidCredential();
		return this.list();
	}

	async requestContext(signal?: AbortSignal): Promise<AntigravityRequestContext> {
		const generation = this.generation;
		const combined = signal ? AbortSignal.any([signal, this.requests.signal]) : this.requests.signal;
		combined.throwIfAborted();
		const credential = await this.getValidCredential();
		combined.throwIfAborted();
		if (!this.identity || this.identity.expires <= Date.now()) {
			this.identity = { value: await fetchAntigravityIdentity((input, init) => this.options.fetch(input, {
				...init, signal: AbortSignal.any([combined, init?.signal ?? AbortSignal.timeout(10_000)]),
			})), expires: Date.now() + 6 * 60 * 60 * 1000 };
		}
		combined.throwIfAborted();
		const account = this.options.store.account("antigravity");
		if (generation !== this.generation || !account?.projectId) throw new Error("Antigravity 登录状态已变更，请重新选择账号");
		return {
			accessToken: credential.accessToken, projectId: account.projectId, identity: this.identity.value, signal: combined,
			scope: createHash("sha256").update(`${account.email}\0${account.projectId}`).digest("hex"),
		};
	}

	sendModelRequest(payload: unknown, auth: AntigravityRequestContext): Promise<Response> {
		auth.signal.throwIfAborted();
		return this.options.fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
			method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.accessToken}`, "User-Agent": auth.identity.userAgent },
			body: JSON.stringify(payload), signal: auth.signal,
		});
	}

	logout(): OAuthProviderSummary {
		this.cancel();
		this.generation++;
		this.requests.abort(); this.requests = new AbortController();
		this.refreshAbort?.abort();
		this.refreshing = undefined;
		this.options.store.delete("antigravity");
		return this.list();
	}

	close(): void { this.cancel(); this.generation++; this.refreshAbort?.abort(); this.requests.abort(); }
}
