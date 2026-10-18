import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { validGitHubCredentials, type GitHubAuthorization, type GitHubAuthorizationMethod, type GitHubOAuthCredentials, type GitHubOAuthGrant } from "./contracts";
import type { GitHubSessionStore, GitHubAuthorizationDoc } from "./store";

export interface GitHubAppConfig {
	clientId: string;
	clientSecret: string;
	callbackUrl: string;
	encryptionKey: string;
	appSlug: string;
}

export class GitHubAuthorizationError extends Error {
	constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

const messages: Record<string, string> = {
	access_denied: "GitHub 授权已取消，请重新连接。",
	expired_token: "授权已过期，请重新开始。",
	incorrect_device_code: "设备码无效，请重新开始。",
	device_flow_disabled: "GitHub App 尚未启用设备码授权，请联系管理员。",
	bad_refresh_token: "GitHub 登录已失效，请重新授权。",
	bad_verification_code: "GitHub 授权码已失效，请重新开始。",
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const EXPIRES_MS = 15 * 60_000;

/** Durable, short-lived handoff sessions, bound to a separate desktop-only secret.
 * Browser state alone cannot retrieve credentials; completed grants are consumed once. */
export class GitHubAuthorizationService {
	constructor(
		private readonly config: GitHubAppConfig | undefined,
		private readonly store: GitHubSessionStore,
		private readonly request: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) {}

	private configured(): GitHubAppConfig {
		if (!this.config) throw new GitHubAuthorizationError("not_configured", "公共服务器尚未配置 GitHub App，请完成应用注册和服务器配置。", 503);
		return this.config;
	}

	private seal(id: string, value: unknown): string {
		const key = createHash("sha256").update(this.configured().encryptionKey).digest();
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(Buffer.from(id));
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
	}

	private unseal<T>(id: string, value: string): T {
		const key = createHash("sha256").update(this.configured().encryptionKey).digest();
		const bytes = Buffer.from(value, "base64url");
		const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
		cipher.setAAD(Buffer.from(id));
		cipher.setAuthTag(bytes.subarray(12, 28));
		return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8")) as T;
	}

	private async github(path: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await this.request(`https://github.com${path}`, {
				method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
				headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(fields),
			});
		} catch { throw new GitHubAuthorizationError("github_unavailable", "暂时无法连接 GitHub，请稍后重试。", 502); }
		if (!response.ok) throw new GitHubAuthorizationError("github_unavailable", "GitHub 授权服务暂时不可用，请稍后重试。", 502);
		const body: unknown = await response.json().catch(() => null);
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new GitHubAuthorizationError("github_unavailable", "GitHub 返回了无效的授权响应。", 502);
		return body as Record<string, unknown>;
	}

	private error(code: unknown): GitHubAuthorizationError {
		const known = typeof code === "string" && Object.hasOwn(messages, code);
		return new GitHubAuthorizationError(known ? code as string : "authorization_failed", known ? messages[code as string]! : "GitHub 授权失败，请重试或联系管理员检查应用配置。");
	}

	private credentials(body: Record<string, unknown>): GitHubOAuthCredentials {
		if (body.error) throw this.error(body.error);
		const ttl = (key: string) => {
			if (body[key] === undefined) return undefined;
			if (typeof body[key] !== "number" || !Number.isFinite(body[key]) || (body[key] as number) <= 0) throw new GitHubAuthorizationError("invalid_response", "GitHub 返回了无效的令牌有效期。", 502);
			return this.now() + (body[key] as number) * 1000;
		};
		const result = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: ttl("expires_in"), refreshExpiresAt: ttl("refresh_token_expires_in") };
		if (!validGitHubCredentials(result)) throw new GitHubAuthorizationError("invalid_response", "GitHub 返回了无效的凭据。", 502);
		return result;
	}

	/** Verify actual repository access; OAuth consent alone does not install the app. */
	private async hasRepositories(credentials: GitHubOAuthCredentials): Promise<boolean> {
		const get = async (path: string): Promise<Record<string, unknown>> => {
			try {
				const response = await this.request(`https://api.github.com${path}`, {
					redirect: "error", signal: AbortSignal.timeout(20_000),
					headers: { accept: "application/vnd.github+json", authorization: `Bearer ${credentials.accessToken}`, "X-GitHub-Api-Version": "2022-11-28" },
				});
				if (!response.ok) throw new Error();
				const value: unknown = await response.json();
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
				return value as Record<string, unknown>;
			} catch { throw new GitHubAuthorizationError("github_unavailable", "暂时无法确认 GitHub 仓库访问权限，请稍后重试。", 502); }
		};
		for (let page = 1; page <= 10; page++) {
			const body = await get(`/user/installations?per_page=100&page=${page}`);
			if (!Array.isArray(body?.installations)) throw new GitHubAuthorizationError("invalid_response", "GitHub 返回了无效的安装信息。", 502);
			for (const value of body.installations) {
				if (!value || typeof value !== "object") continue;
				const installation = value as { id?: number; suspended_at?: unknown };
				if (typeof installation.id !== "number" || !Number.isSafeInteger(installation.id) || installation.id <= 0 || installation.suspended_at) continue;
				const repos = await get(`/user/installations/${installation.id}/repositories?per_page=1`);
				if (Array.isArray(repos?.repositories) && repos.repositories.length > 0) return true;
			}
			if (body.installations.length < 100) return false;
		}
		throw new GitHubAuthorizationError("github_unavailable", "仓库安装数量过多，请稍后重试。", 502);
	}

	async start(method: GitHubAuthorizationMethod, secret: string): Promise<GitHubAuthorization> {
		const config = this.configured();
		const id = random();
		const installationUrl = `https://github.com/apps/${config.appSlug}/installations/new`;
		let expiresAt = this.now() + EXPIRES_MS;
		let interval = 2;
		let userCode: string | undefined;
		let url: string;
		let context: unknown;
		if (method === "browser") {
			const verifier = random();
			context = { verifier };
			const authorize = new URL("https://github.com/login/oauth/authorize");
			authorize.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callbackUrl, state: id,
				code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "offline_access" }).toString();
			url = authorize.href;
		} else {
			const body = await this.github("/login/device/code", { client_id: config.clientId, scope: "offline_access" });
			if (body.error) throw this.error(body.error);
			if (typeof body.device_code !== "string" || !body.device_code || body.device_code.length > 512 ||
				typeof body.user_code !== "string" || !/^[A-Z0-9-]{6,32}$/.test(body.user_code) ||
				body.verification_uri !== "https://github.com/login/device" ||
				typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
				throw new GitHubAuthorizationError("invalid_response", "GitHub 返回了无效的设备码。", 502);
			}
			context = { deviceCode: body.device_code };
			userCode = body.user_code;
			url = body.verification_uri;
			expiresAt = this.now() + Math.min(body.expires_in * 1000, EXPIRES_MS);
			interval = typeof body.interval === "number" && Number.isFinite(body.interval) ? Math.max(5, Math.min(60, body.interval)) : 5;
		}
		await this.store.create({ _id: id, method, secretHash: digest(secret), status: "pending", expiresAt: new Date(expiresAt),
			nextPollAt: method === "device" ? this.now() + interval * 1000 : 0, interval, payload: this.seal(id, context) });
		return { id, method, url, userCode, expiresAt, interval, installationUrl };
	}

	private async session(id: string, secret: string): Promise<GitHubAuthorizationDoc> {
		this.configured();
		const session = await this.store.get(id);
		if (!session || !timingSafeEqual(Buffer.from(session.secretHash, "hex"), Buffer.from(digest(secret), "hex")))
			throw new GitHubAuthorizationError("unauthorized", "授权会话不存在或无法访问。", 401);
		if (session.expiresAt.getTime() <= this.now()) {
			await this.store.remove(id);
			throw this.error("expired_token");
		}
		return session;
	}

	async callback(state: string, code?: string, denied?: string): Promise<string | undefined> {
		this.configured();
		const session = await this.store.get(state);
		if (!session || session.method !== "browser" || session.status !== "pending" || !await this.store.claim(state, this.now()))
			throw new GitHubAuthorizationError("invalid_state", "授权链接无效、已使用或已过期，请回到 NekoCode 重试。");
		try {
			if (denied || !code) throw this.error("access_denied");
			const { verifier } = this.unseal<{ verifier: string }>(state, session.payload);
			const config = this.configured();
			const body = await this.github("/login/oauth/access_token", { client_id: config.clientId, client_secret: config.clientSecret,
				code, redirect_uri: config.callbackUrl, code_verifier: verifier });
			return await this.ready(session, this.credentials(body));
		} catch (error) {
			await this.store.update(state, { status: "error", error: error instanceof GitHubAuthorizationError ? error.message : "授权失败，请重新开始。", payload: "" });
			throw error;
		}
	}

	private async ready(session: GitHubAuthorizationDoc, credentials: GitHubOAuthCredentials) {
		const grant: GitHubOAuthGrant = { credentials, method: session.method, installationUrl: `https://github.com/apps/${this.configured().appSlug}/installations/new` };
		// Keep credentials encrypted and unavailable to the desktop until installation is usable.
		let installed = false;
		try { installed = await this.hasRepositories(credentials); }
		catch (error) { if (!(error instanceof GitHubAuthorizationError) || error.status !== 502) throw error; }
		await this.store.update(session._id, { status: installed ? "ready" : "installing", nextPollAt: this.now() + 5000, payload: this.seal(session._id, grant) });
		return installed ? undefined : grant.installationUrl;
	}

	async poll(id: string, secret: string): Promise<{ state: "pending"; interval: number; url?: string } | { state: "complete"; grant: GitHubOAuthGrant }> {
		let session = await this.session(id, secret);
		if (session.status === "pending" && session.method === "device" && await this.store.claim(id, this.now())) {
			try {
				const context = this.unseal<{ deviceCode: string }>(id, session.payload);
				const body = await this.github("/login/oauth/access_token", { client_id: this.configured().clientId, device_code: context.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
				if (body.error === "authorization_pending" || body.error === "slow_down") {
					const interval = body.error === "slow_down" ? session.interval + 5 : session.interval;
					await this.store.update(id, { status: "pending", interval, nextPollAt: this.now() + interval * 1000 });
					return { state: "pending", interval };
				}
				await this.ready(session, this.credentials(body));
			} catch (error) {
				// Keep transient upstream failures retryable without losing the device code.
				if (error instanceof GitHubAuthorizationError && error.status === 502) {
					await this.store.update(id, { status: "pending", nextPollAt: this.now() + session.interval * 1000 });
					return { state: "pending", interval: session.interval };
				}
				await this.store.update(id, { status: "error", error: error instanceof GitHubAuthorizationError ? error.message : "授权失败，请重新开始。", payload: "" });
			}
			session = await this.session(id, secret);
		}
		if (session.status === "installing") {
			const grant = this.unseal<GitHubOAuthGrant>(id, session.payload);
			if (await this.store.claim(id, this.now())) {
				try {
					const installed = await this.hasRepositories(grant.credentials);
					await this.store.update(id, { status: installed ? "ready" : "installing", nextPollAt: this.now() + 5000 });
				} catch (error) {
					await this.store.update(id, { status: "installing", nextPollAt: this.now() + 5000 });
					if (!(error instanceof GitHubAuthorizationError) || error.status !== 502) throw error;
				}
				session = await this.session(id, secret);
			}
			if (session.status !== "ready") return { state: "pending", interval: 5, ...(session.method === "device" ? { url: grant.installationUrl } : {}) };
		}
		if (session.status === "error") throw new GitHubAuthorizationError("authorization_failed", session.error ?? "授权失败，请重新开始。");
		if (session.status === "ready") {
			const consumed = await this.store.take(id, digest(secret), this.now());
			if (!consumed) throw new GitHubAuthorizationError("already_consumed", "授权结果已领取，请重新连接。");
			return { state: "complete", grant: this.unseal<GitHubOAuthGrant>(id, consumed.payload) };
		}
		return { state: "pending", interval: session.interval };
	}

	async cancel(id: string, secret: string) {
		await this.session(id, secret);
		await this.store.remove(id);
	}

	async refresh(refreshToken: string): Promise<GitHubOAuthCredentials> {
		const config = this.configured();
		return this.credentials(await this.github("/login/oauth/access_token", { client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }));
	}
}
