import { randomBytes } from "node:crypto";
import { validGitHubCredentials, type GitHubAuthorization, type GitHubAuthorizationMethod, type GitHubAuthorizationPoll, type GitHubOAuthCredentials, type GitHubOAuthGrant } from "../shared/github-oauth";
import type { GitHubAuthStatus } from "../shared/pullRequests";

const PUBLIC_SERVER = "https://codeapi.nekofun.top";

export class GitHubOAuthClient {
	constructor(private readonly request: typeof fetch = fetch, private readonly baseUrl = PUBLIC_SERVER, private readonly now: () => number = Date.now) {}

	private async call(path: string, body: unknown, secret?: string, signal?: AbortSignal): Promise<unknown> {
		const response = await this.request(`${this.baseUrl}/github/auth/${path}`, {
			method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
			headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
			body: JSON.stringify(body),
		});
		const value = await response.json().catch(() => null) as { error?: { message?: string } } | null;
		if (!response.ok || value?.error) throw new Error(value?.error?.message ?? `GitHub 授权服务请求失败（HTTP ${response.status}）`);
		return value;
	}

	async start(method: GitHubAuthorizationMethod, secret: string, signal?: AbortSignal): Promise<GitHubAuthorization> {
		const value = await this.call("start", { method, secret }, undefined, signal) as GitHubAuthorization;
		const expectedPath = method === "browser" ? "/login/oauth/authorize" : "/login/device";
		let validUrl = false;
		try { const url = new URL(value.url); validUrl = url.origin === "https://github.com" && url.pathname === expectedPath && !url.username && !url.password; } catch {}
		if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.id) || value.method !== method || !validUrl ||
			!Number.isFinite(value.expiresAt) || value.expiresAt <= this.now() || !Number.isFinite(value.interval) || value.interval < 1 ||
			(method === "device" && (typeof value.userCode !== "string" || !/^[A-Z0-9-]{6,32}$/.test(value.userCode)))) throw new Error("授权服务返回了无效的会话。");
		if (value.installationUrl && !/^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(value.installationUrl)) throw new Error("授权服务返回了无效的仓库授权地址。");
		return value;
	}

	async poll(id: string, secret: string, signal?: AbortSignal): Promise<{ state: "pending"; interval: number; url?: string } | { state: "complete"; grant: GitHubOAuthGrant }> {
		const value = await this.call("poll", { id }, secret, signal) as { state: string; interval: number; url?: string; grant?: GitHubOAuthGrant };
		if (value?.state === "pending" && Number.isFinite(value.interval) && value.interval >= 1) {
			if (value.url && !/^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(value.url)) throw new Error("授权服务返回了无效的仓库授权地址。");
			return { state: "pending", interval: value.interval, ...(value.url ? { url: value.url } : {}) };
		}
		if (value?.state === "complete" && value.grant && validGitHubCredentials(value.grant.credentials) && ["browser", "device"].includes(value.grant.method) &&
			(!value.grant.installationUrl || /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(value.grant.installationUrl))) return { state: "complete", grant: value.grant };
		throw new Error("授权服务返回了无效的结果。");
	}

	async cancel(id: string, secret: string): Promise<void> { await this.call("cancel", { id }, secret); }

	async refresh(refreshToken: string): Promise<GitHubOAuthCredentials> {
		const value = await this.call("refresh", { refreshToken });
		if (!validGitHubCredentials(value)) throw new Error("GitHub 登录续期返回了无效凭据，请重新授权。");
		return value;
	}
}

interface Attempt { controller: AbortController; secret: string; flow?: GitHubAuthorization; nextPollAt: number; installationOpened?: boolean; poll?: Promise<GitHubAuthorizationPoll> }

/** One desktop-owned sign-in at a time. Secrets remain in main, never in IPC results. */
export class GitHubLoginService {
	private active: Attempt | null = null;
	constructor(
		private readonly client: GitHubOAuthClient,
		private readonly openExternal: (url: string) => Promise<unknown>,
		private readonly save: (grant: GitHubOAuthGrant, stillActive: () => boolean) => Promise<GitHubAuthStatus>,
		private readonly assertStorage: () => void,
		private readonly now: () => number = Date.now,
	) {}

	async start(method: GitHubAuthorizationMethod): Promise<GitHubAuthorization> {
		if (method !== "browser" && method !== "device") throw new Error("不支持的 GitHub 授权方式。");
		this.assertStorage();
		this.cancel();
		const attempt: Attempt = { controller: new AbortController(), secret: randomBytes(32).toString("base64url"), nextPollAt: 0 };
		this.active = attempt;
		try {
			const flow = await this.client.start(method, attempt.secret, attempt.controller.signal);
			attempt.flow = flow;
			if (this.active !== attempt) { void this.client.cancel(flow.id, attempt.secret).catch(() => {}); throw new Error("授权已取消。"); }
			attempt.nextPollAt = this.now() + flow.interval * 1000;
			// Device flow deliberately waits for the user's explicit "open" click.
			if (method === "browser") {
				try { await this.openExternal(flow.url); } catch { /* The UI offers a retry button; do not discard the session. */ }
			}
			return flow;
		} catch (error) {
			if (this.active === attempt) this.cancel();
			throw error;
		}
	}

	async open(): Promise<void> {
		if (!this.active?.flow) throw new Error("请先开始 GitHub 授权。");
		await this.openExternal(this.active.flow.url);
	}

	async poll(id: string): Promise<GitHubAuthorizationPoll> {
		const attempt = this.active;
		if (!attempt?.flow || attempt.flow.id !== id) throw new Error("授权已取消或已结束。");
		if (attempt.flow.expiresAt <= this.now()) { this.cancel(); throw new Error("授权已过期，请重新开始。"); }
		if (attempt.poll) return attempt.poll;
		if (this.now() < attempt.nextPollAt) return { state: "pending", interval: Math.max(1, Math.ceil((attempt.nextPollAt - this.now()) / 1000)) };
		const work = (async (): Promise<GitHubAuthorizationPoll> => {
			const value = await this.client.poll(id, attempt.secret, attempt.controller.signal);
			if (this.active !== attempt) throw new Error("授权已取消。");
			if (value.state === "pending") {
				attempt.nextPollAt = this.now() + value.interval * 1000;
				if (value.url) {
					attempt.flow!.url = value.url;
					if (!attempt.installationOpened) {
						try { await this.openExternal(value.url); attempt.installationOpened = true; } catch { /* Retry on the next poll or via Open. */ }
					}
				}
				return { state: "pending", interval: value.interval };
			}
			const status = await this.save(value.grant, () => this.active === attempt);
			if (this.active !== attempt) throw new Error("授权已取消。");
			this.active = null;
			return { state: "complete", status };
		})();
		attempt.poll = work;
		try { return await work; } finally { attempt.poll = undefined; }
	}

	cancel(id?: string): void {
		const attempt = this.active;
		if (id !== undefined && attempt?.flow?.id !== id) return;
		this.active = null;
		attempt?.controller.abort();
		if (attempt?.flow) void this.client.cancel(attempt.flow.id, attempt.secret).catch(() => {});
	}
}
