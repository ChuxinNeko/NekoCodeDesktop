import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, safeStorage } from "electron";
import type { GitHubAuthStatus } from "../shared/pullRequests";

const execFileP = promisify(execFile);

const TOKEN_FILE = "github-auth.json";
const MAX_TOKEN_LENGTH = 512;
const GITHUB_API = "https://api.github.com";

interface StoredAuth {
	version: 1;
	encryptedToken: string;
	login?: string;
}

/**
 * GitHub credentials, resolved in this order:
 *
 *  1. a token saved in Settings, encrypted with Electron `safeStorage`;
 *  2. `gh auth token` when the GitHub CLI is installed and logged in;
 *  3. no token — the panel still reads public repositories anonymously.
 *
 * The `gh` fallback exists so a machine that already has the CLI configured needs
 * no extra setup, without making `gh` a requirement (a manual install is exactly
 * what this panel is trying to avoid).
 */
export class GitHubAuthService {
	private readonly filePath: string;
	private cachedGhToken: { value: string | null; checkedAt: number } | null = null;
	private cachedLogin: string | null = null;

	constructor() {
		const dir = app.getPath("userData");
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
		if (!safeStorage.isEncryptionAvailable()) return null;
		try {
			return safeStorage
				.decryptString(Buffer.from(stored.encryptedToken, "base64"))
				.trim();
		} catch {
			return null;
		}
	}

	private async readGhToken(): Promise<string | null> {
		const cached = this.cachedGhToken;
		if (cached && Date.now() - cached.checkedAt < 30_000) return cached.value;
		let value: string | null = null;
		try {
			const { stdout } = await execFileP("gh", ["auth", "token"], { timeout: 5_000 });
			const trimmed = stdout.trim();
			value = trimmed.length > 0 ? trimmed : null;
		} catch {
			// gh is not installed, not on PATH, or not logged in.
			value = null;
		}
		this.cachedGhToken = { value, checkedAt: Date.now() };
		return value;
	}

	/** The token to send to the API, or null for anonymous access. */
	async resolveToken(): Promise<{ token: string | null; source: GitHubAuthStatus["source"] }> {
		const stored = this.readStored();
		if (stored) {
			const decrypted = this.decryptStoredToken(stored);
			if (decrypted) return { token: decrypted, source: "settings" };
		}
		const ghToken = await this.readGhToken();
		if (ghToken) return { token: ghToken, source: "gh-cli" };
		return { token: null, source: "anonymous" };
	}

	async status(): Promise<GitHubAuthStatus> {
		const { token, source } = await this.resolveToken();
		const encryptionAvailable = safeStorage.isEncryptionAvailable();
		const storedLogin = this.readStored()?.login;
		if (storedLogin) this.cachedLogin = storedLogin;
		return {
			configured: token !== null,
			source,
			...(this.cachedLogin ? { login: this.cachedLogin } : {}),
			encryptionAvailable,
			...(encryptionAvailable
				? {}
				: {
						warning:
							"系统密钥环不可用 (safeStorage)，无法保存 GitHub token；仍可使用 gh CLI 或匿名访问公开仓库",
					}),
		};
	}

	/** Validate the token against the API and return its login, or throw. */
	private async verifyToken(token: string): Promise<string> {
		const response = await fetch(`${GITHUB_API}/user`, {
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
		return typeof body.login === "string" ? body.login : "unknown";
	}

	async save(token: string): Promise<GitHubAuthStatus> {
		const trimmed = token.trim();
		if (trimmed.length === 0) throw new Error("Token 不能为空");
		if (trimmed.length > MAX_TOKEN_LENGTH) throw new Error("Token 过长");
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error("系统密钥环不可用，无法安全保存 GitHub token");
		}
		const login = await this.verifyToken(trimmed);
		const record: StoredAuth = {
			version: 1,
			encryptedToken: safeStorage.encryptString(trimmed).toString("base64"),
			login,
		};
		const tmp = `${this.filePath}.tmp-${String(process.pid)}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, this.filePath);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
		this.cachedLogin = login;
		return this.status();
	}

	async clear(): Promise<GitHubAuthStatus> {
		rmSync(this.filePath, { force: true });
		this.cachedLogin = null;
		return this.status();
	}
}
