import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { safeStorage } from "electron";
import { GitHubOAuthClient } from "./github-oauth";
import { validGitHubCredentials, type GitHubOAuthCredentials, type GitHubOAuthGrant } from "../shared/github-oauth";
import type { GitHubAccount, GitHubProfile, GitHubRepository } from "../shared/github-profile";
import type { GitHubAuthStatus } from "../shared/pullRequests";

const execFileP = promisify(execFile);

const TOKEN_FILE = "github-auth.json";
const MAX_TOKEN_LENGTH = 512;
const GITHUB_API = "https://api.github.com";

interface StoredAuth {
	version: 1;
	encryptedToken: string;
	login?: string;
	encryptedOAuth?: string;
	authorizationMethod?: "browser" | "device";
	installationUrl?: string;
}

/**
 * GitHub credentials, resolved in this order:
 *
 *  1. an OAuth connection (with renewal), or a manual token, encrypted with Electron `safeStorage`;
 *  2. `gh auth token` when the GitHub CLI is installed and logged in;
 *  3. no token — the panel still reads public repositories anonymously.
 *
 * The `gh` fallback exists so a machine that already has the CLI configured needs
 * no extra setup, without making `gh` a requirement (a manual install is exactly
 * what this panel is trying to avoid).
 */
export class GitHubCredentialStore {
	private readonly filePath: string;
	private cachedGhToken: { value: string | null; checkedAt: number } | null = null;
	private cachedLogin: string | null = null;
	private refreshPromise: Promise<string> | null = null;
	private revision = 0;
	private readonly oauthClient: Pick<GitHubOAuthClient, "refresh">;
	private readonly encryption: Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString" | "getSelectedStorageBackend">;
	private readonly request: typeof fetch;
	private readonly requestTimeoutMs: number;
	private readonly ghTokenReader?: () => Promise<string | null>;
	private readonly now: () => number;

	constructor(options: {
		userDataDir: string;
		encryption: Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString" | "getSelectedStorageBackend">;
		request?: typeof fetch;
		oauthClient?: Pick<GitHubOAuthClient, "refresh">;
		readGhToken?: () => Promise<string | null>;
		now?: () => number;
		/** How long a direct api.github.com call may sit before the settings page gives up. */
		requestTimeoutMs?: number;
	}) {
		this.encryption = options.encryption;
		this.request = options.request ?? fetch;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 12_000;
		this.oauthClient = options.oauthClient ?? new GitHubOAuthClient(this.request);
		this.ghTokenReader = options.readGhToken;
		this.now = options.now ?? Date.now;
		const dir = options.userDataDir;
		mkdirSync(dir, { recursive: true });
		this.filePath = join(dir, TOKEN_FILE);
	}

	private readStored(): StoredAuth | null {
		if (!existsSync(this.filePath)) return null;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				(parsed as StoredAuth).version === 1 &&
				typeof (parsed as StoredAuth).encryptedToken === "string"
			) {
				return parsed as StoredAuth;
			}
			return null;
		} catch {
			return null;
		}
	}

	private decryptStoredToken(stored: StoredAuth): string | null {
		if (!this.encryption.isEncryptionAvailable()) return null;
		try {
			return this.encryption
				.decryptString(Buffer.from(stored.encryptedToken, "base64"))
				.trim();
		} catch {
			return null;
		}
	}

	private async readGhToken(): Promise<string | null> {
		if (this.ghTokenReader) return this.ghTokenReader();
		const cached = this.cachedGhToken;
		if (cached && this.now() - cached.checkedAt < 30_000) return cached.value;
		let value: string | null = null;
		try {
			const { stdout } = await execFileP("gh", ["auth", "token"], { timeout: 5_000 });
			const trimmed = stdout.trim();
			value = trimmed.length > 0 ? trimmed : null;
		} catch {
			// gh is not installed, not on PATH, or not logged in.
			value = null;
		}
		this.cachedGhToken = { value, checkedAt: this.now() };
		return value;
	}

	/** The token to send to the API, or null for anonymous access. */
	async resolveToken(): Promise<{ token: string | null; source: GitHubAuthStatus["source"] }> {
		const stored = this.readStored();
		if (stored) {
			const decrypted = this.decryptStoredToken(stored);
			if (decrypted) {
				if (stored.encryptedOAuth) {
					let credentials: unknown;
					try { credentials = JSON.parse(this.encryption.decryptString(Buffer.from(stored.encryptedOAuth, "base64"))); } catch { throw new Error("GitHub 登录凭据无法读取，请重新授权。"); }
					if (!validGitHubCredentials(credentials)) throw new Error("GitHub 登录凭据无效，请重新授权。");
					if (credentials.expiresAt !== undefined && credentials.expiresAt <= this.now() + 60_000) {
						if (!this.refreshPromise) {
							this.refreshPromise = this.refreshOAuth(stored, credentials).finally(() => { this.refreshPromise = null; });
						}
						return { token: await this.refreshPromise, source: "oauth" };
					}
					return { token: credentials.accessToken, source: "oauth" };
				}
				return { token: decrypted, source: "settings" };
			}
		}
		const ghToken = await this.readGhToken();
		if (ghToken) return { token: ghToken, source: "gh-cli" };
		return { token: null, source: "anonymous" };
	}

	async status(): Promise<GitHubAuthStatus> {
		let resolved: Awaited<ReturnType<GitHubCredentialStore["resolveToken"]>>;
		let warning: string | undefined;
		try { resolved = await this.resolveToken(); }
		catch { resolved = { token: null, source: "oauth" }; warning = "GitHub 登录续期失败，请重试或重新授权。"; }
		const { token, source } = resolved;
		const encryptionAvailable = this.encryptionAvailable();
		const stored = this.readStored();
		const storedLogin = stored?.login;
		this.cachedLogin = source === "oauth" || source === "settings" ? storedLogin ?? null : null;
		return {
			configured: token !== null,
			source,
			...(source === "oauth" && stored?.authorizationMethod ? { authorizationMethod: stored.authorizationMethod } : {}),
			...(source === "oauth" && stored?.installationUrl ? { installationUrl: stored.installationUrl } : {}),
			...(this.cachedLogin ? { login: this.cachedLogin } : {}),
			encryptionAvailable,
			...(warning ? { warning } : encryptionAvailable
				? {}
				: {
						warning:
							"系统密钥环不可用 (safeStorage)，无法保存 GitHub token；仍可使用 gh CLI 或匿名访问公开仓库",
					}),
		};
	}

	/**
	 * The signed-in account and the repositories that token can see.
	 * Used by the settings page after a connection exists; nothing here is stored.
	 */
	async profile(): Promise<GitHubProfile> {
		const { token } = await this.resolveToken();
		if (!token) throw new Error("未配置 GitHub 授权。");
		// Repositories are the slow call. Start them with the account request so a
		// stalled repo list cannot add a second full wait after /user returns.
		const userRequest = this.githubJson("/user", token);
		const reposRequest = this.githubJson(
			"/user/repos?per_page=30&sort=updated&affiliation=owner,collaborator,organization_member",
			token,
		);
		// The account request may fail first. Keep the repo request from rejecting alone.
		void reposRequest.catch(() => {});
		const user = await userRequest;
		const account = projectAccount(user.body);
		if (!account) throw new Error("GitHub 返回了无效的账号信息。");
		// The window cannot load avatars.githubusercontent.com itself: its content
		// policy only allows images from this app. Fetch through the same proxy
		// as the API and hand back a data URL.
		const shown = { ...account, avatarUrl: account.avatarUrl ? await this.avatarData(account.avatarUrl) : null };
		try {
			const repos = await reposRequest;
			return { account: shown, ...projectRepositories(repos.body, repos.link) };
		} catch (error) {
			const repositoriesWarning = error instanceof Error ? error.message : String(error);
			return { account: shown, repositories: [], repositoriesWarning };
		}
	}

	private async avatarData(url: string): Promise<string | null> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.min(this.requestTimeoutMs, 8_000));
		try {
			const response = await this.request(url, {
				signal: controller.signal,
				redirect: "follow",
				headers: { accept: "image/png,image/jpeg,image/webp,image/gif", "user-agent": "nekocode-desktop" },
			});
			let finalHost = "";
			try { finalHost = new URL(response.url || url).hostname; } catch { finalHost = ""; }
			if (!response.ok || !AVATAR_HOSTS.has(finalHost)) {
				await response.body?.cancel();
				return null;
			}
			const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
			if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)) {
				await response.body?.cancel();
				return null;
			}
			const reader = response.body?.getReader();
			if (!reader) return null;
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > 512 * 1024) {
					await reader.cancel();
					return null;
				}
				chunks.push(value);
			}
			return total > 0 ? `data:${type};base64,${Buffer.concat(chunks).toString("base64")}` : null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Direct call to api.github.com from this machine. The public auth server is
	 * not on this path. A blackholed connection must still reject: aborting fetch
	 * is not enough when the socket never becomes abortable.
	 */
	private async githubJson(path: string, token: string): Promise<{ body: unknown; link: string | null }> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("连接 GitHub API 超时。读取账号和仓库由本机直接访问 api.github.com，不经过授权服务器。"));
			}, this.requestTimeoutMs);
		});
		const attempt = this.readGitHub(path, token, controller.signal);
		void attempt.catch(() => {});
		try {
			return await Promise.race([attempt, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async readGitHub(path: string, token: string, signal: AbortSignal): Promise<{ body: unknown; link: string | null }> {
		const response = await this.request(`${GITHUB_API}${path}`, {
			signal,
			redirect: "error",
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"user-agent": "nekocode-desktop",
				"x-github-api-version": "2022-11-28",
			},
		});
		if (!response.ok) throw new Error(`GitHub 拒绝了该请求（HTTP ${String(response.status)}）。请重新授权。`);
		return { body: await response.json(), link: response.headers.get("link") };
	}

	/** Validate the token against the API and return its login, or throw. */
	private async verifyToken(token: string): Promise<string> {
		const response = await this.request(`${GITHUB_API}/user`, {
			signal: AbortSignal.timeout(15_000),
			redirect: "error",
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"x-github-api-version": "2022-11-28",
			},
		});
		if (!response.ok) {
			throw new Error(`GitHub rejected the token (HTTP ${String(response.status)})`);
		}
		const body = (await response.json()) as { login?: unknown };
		if (typeof body.login !== "string" || !body.login) throw new Error("GitHub 返回了无效的账号信息。");
		return body.login;
	}

	encryptionAvailable(): boolean {
		return this.encryption.isEncryptionAvailable() && !(process.platform === "linux" && this.encryption.getSelectedStorageBackend() === "basic_text");
	}

	assertStorage(): void {
		if (!this.encryptionAvailable()) throw new Error("系统密钥环不可用，无法安全保存 GitHub 凭据；请启用系统密钥环或使用已登录的 gh CLI。");
	}

	private persist(record: StoredAuth): void {
		const tmp = `${this.filePath}.tmp-${String(process.pid)}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, this.filePath);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
		this.revision++;
		this.cachedLogin = record.login ?? null;
	}

	async save(token: string): Promise<GitHubAuthStatus> {
		const trimmed = token.trim();
		if (trimmed.length === 0) throw new Error("Token 不能为空");
		if (trimmed.length > MAX_TOKEN_LENGTH || /\s/.test(trimmed)) throw new Error("Token 格式不正确");
		this.assertStorage();
		const revision = this.revision;
		const login = await this.verifyToken(trimmed);
		if (revision !== this.revision) throw new Error("GitHub 登录状态已改变，请重试。");
		this.persist({ version: 1, encryptedToken: this.encryption.encryptString(trimmed).toString("base64"), login });
		return this.status();
	}

	private persistOAuth(grant: GitHubOAuthGrant, login: string): void {
		this.assertStorage();
		this.persist({ version: 1, encryptedToken: this.encryption.encryptString(grant.credentials.accessToken).toString("base64"),
			encryptedOAuth: this.encryption.encryptString(JSON.stringify(grant.credentials)).toString("base64"),
			authorizationMethod: grant.method, installationUrl: grant.installationUrl, login });
	}

	async saveOAuth(grant: GitHubOAuthGrant, stillActive: () => boolean): Promise<GitHubAuthStatus> {
		this.assertStorage();
		if (!validGitHubCredentials(grant.credentials)) throw new Error("GitHub 授权凭据无效。");
		const revision = this.revision;
		const login = await this.verifyToken(grant.credentials.accessToken);
		if (!stillActive() || revision !== this.revision) throw new Error("授权已取消或账号状态已改变。");
		this.persistOAuth(grant, login);
		return this.status();
	}

	private async refreshOAuth(stored: StoredAuth, credentials: GitHubOAuthCredentials): Promise<string> {
		if (!credentials.refreshToken || (credentials.refreshExpiresAt !== undefined && credentials.refreshExpiresAt <= this.now())) throw new Error("GitHub 登录已过期，请重新授权。");
		this.assertStorage();
		const revision = this.revision;
		const next = await this.oauthClient.refresh(credentials.refreshToken);
		if (revision !== this.revision) throw new Error("GitHub 登录状态已改变。");
		this.persistOAuth({ credentials: next, method: stored.authorizationMethod ?? "browser", installationUrl: stored.installationUrl }, stored.login ?? "unknown");
		return next.accessToken;
	}

	async clear(): Promise<GitHubAuthStatus> {
		this.revision++;
		rmSync(this.filePath, { force: true });
		this.cachedLogin = null;
		return this.status();
	}
}

const GITHUB_HOSTS = new Set(["github.com"]);
const AVATAR_HOSTS = new Set(["avatars.githubusercontent.com", "private-avatars.githubusercontent.com"]);
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function httpsOn(value: unknown, hosts: Set<string>): string | null {
	if (typeof value !== "string" || value.length > 2048) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
	if (!hosts.has(url.hostname)) return null;
	return url.toString();
}

function clip(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 1_000_000_000) : 0;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function projectAccount(value: unknown): GitHubAccount | null {
	const body = record(value);
	const login = body?.login;
	if (typeof login !== "string" || !LOGIN.test(login)) return null;
	return {
		login,
		name: clip(body?.name, 120),
		avatarUrl: httpsOn(body?.avatar_url, AVATAR_HOSTS),
		htmlUrl: httpsOn(body?.html_url, GITHUB_HOSTS) ?? `https://github.com/${login}`,
		bio: clip(body?.bio, 280),
		company: clip(body?.company, 120),
		location: clip(body?.location, 120),
		publicRepos: count(body?.public_repos),
		followers: count(body?.followers),
		following: count(body?.following),
	};
}

function projectRepositories(value: unknown, link: string | null): Pick<GitHubProfile, "repositories" | "truncated"> {
	if (!Array.isArray(value)) throw new Error("GitHub 返回了无效的仓库列表。");
	const repositories: GitHubRepository[] = [];
	for (const entry of value) {
		const body = record(entry);
		if (!body) continue;
		const fullName = body.full_name;
		const name = body.name;
		const htmlUrl = httpsOn(body.html_url, GITHUB_HOSTS);
		if (typeof fullName !== "string" || !FULL_NAME.test(fullName) || typeof name !== "string" || !name || name.length > 100 || !htmlUrl) continue;
		const updated = typeof body.updated_at === "string" && Number.isFinite(Date.parse(body.updated_at)) ? body.updated_at : "";
		repositories.push({
			name,
			fullName,
			description: clip(body.description, 300),
			private: body.private === true,
			fork: body.fork === true,
			htmlUrl,
			language: clip(body.language, 40),
			stars: count(body.stargazers_count),
			updatedAt: updated,
		});
	}
	return { repositories, ...(link?.includes('rel="next"') ? { truncated: true } : {}) };
}
