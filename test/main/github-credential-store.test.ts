import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubCredentialStore } from "../../src/main/github-credential-store";
import type { GitHubOAuthCredentials } from "../../src/shared/github-oauth";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const encryption = {
	isEncryptionAvailable: () => true,
	getSelectedStorageBackend: () => "gnome_libsecret" as const,
	encryptString: (value: string) => Buffer.from(value.split("").reverse().join("")),
	decryptString: (value: Buffer) => value.toString().split("").reverse().join(""),
};
function fixture(refresh: () => Promise<GitHubOAuthCredentials> = async () => ({ accessToken: "ghu_new", refreshToken: "ghr_new", expiresAt: Date.now() + 3_600_000 })) {
	const directory = mkdtempSync(join(tmpdir(), "neko-github-auth-")); directories.push(directory);
	let now = Date.now();
	const store = new GitHubCredentialStore({ userDataDir: directory, encryption,
		request: (async () => Response.json({ login: "neko" })) as unknown as typeof fetch,
		oauthClient: { refresh }, readGhToken: async () => null, now: () => now });
	return { store, directory, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("GitHub credential lifecycle", () => {
	test("retains existing v1 manual tokens and replaces OAuth secrets when a PAT is saved", async () => {
		const f = fixture();
		writeFileSync(join(f.directory, "github-auth.json"), JSON.stringify({ version: 1, encryptedToken: encryption.encryptString("ghp_old").toString("base64"), login: "neko" }));
		expect(await f.store.resolveToken()).toEqual({ token: "ghp_old", source: "settings" });
		await f.store.saveOAuth({ method: "device", credentials: { accessToken: "ghu_original", refreshToken: "ghr_original" } }, () => true);
		const disk = readFileSync(join(f.directory, "github-auth.json"), "utf8");
		expect(disk).not.toContain("ghu_original"); expect(disk).not.toContain("ghr_original");
		expect((await f.store.status()).authorizationMethod).toBe("device");
		await f.store.save("ghp_manual");
		expect(await f.store.resolveToken()).toEqual({ token: "ghp_manual", source: "settings" });
		expect(readFileSync(join(f.directory, "github-auth.json"), "utf8")).not.toContain("encryptedOAuth");
	});

	test("concurrent API requests renew once and persist the rotated refresh token", async () => {
		let refreshes = 0;
		const f = fixture(async () => { refreshes++; await Promise.resolve(); return { accessToken: "ghu_new", refreshToken: "ghr_rotated", expiresAt: f.now() + 3_600_000 }; });
		await f.store.saveOAuth({ method: "browser", credentials: { accessToken: "ghu_old", refreshToken: "ghr_old", expiresAt: f.now() + 120_000 } }, () => true);
		f.advance(90_000);
		const results = await Promise.all([f.store.resolveToken(), f.store.resolveToken(), f.store.resolveToken()]);
		expect(results.every(r => r.token === "ghu_new")).toBe(true); expect(refreshes).toBe(1);
		const disk = JSON.parse(readFileSync(join(f.directory, "github-auth.json"), "utf8"));
		expect(JSON.parse(encryption.decryptString(Buffer.from(disk.encryptedOAuth, "base64"))).refreshToken).toBe("ghr_rotated");
	});

	test("clear during renewal cannot resurrect a disconnected account", async () => {
		let release!: (credentials: GitHubOAuthCredentials) => void;
		const f = fixture(() => new Promise(resolve => { release = resolve; }));
		await f.store.saveOAuth({ method: "browser", credentials: { accessToken: "ghu_old", refreshToken: "ghr_old", expiresAt: f.now() + 120_000 } }, () => true);
		f.advance(90_000); const resolving = f.store.resolveToken();
		await f.store.clear(); release({ accessToken: "ghu_new", refreshToken: "ghr_new" });
		await expect(resolving).rejects.toThrow("状态已改变");
		expect(await f.store.resolveToken()).toEqual({ token: null, source: "anonymous" });
	});

	test("expired refresh tokens request reauthorization and are not sent to the server", async () => {
		let refreshes = 0; const f = fixture(async () => { refreshes++; throw new Error("must not call"); });
		await f.store.saveOAuth({ method: "browser", credentials: { accessToken: "ghu_old", refreshToken: "ghr_old", expiresAt: f.now() + 120_000, refreshExpiresAt: f.now() + 120_000 } }, () => true);
		f.advance(150_000);
		expect((await f.store.status()).configured).toBe(false);
		expect((await f.store.status()).warning).toContain("重新授权"); expect(refreshes).toBe(0);
	});

	test("a cancelled sign-in never persists its credentials", async () => {
		const f = fixture();
		await expect(f.store.saveOAuth({ method: "device", credentials: { accessToken: "ghu_cancelled" } }, () => false)).rejects.toThrow("已取消");
		expect((await f.store.status()).configured).toBe(false);
	});

	test("profile projects the signed-in account and drops repositories outside github.com", async () => {
		const f = fixture();
		const store = new GitHubCredentialStore({
			userDataDir: f.directory,
			encryption,
			readGhToken: async () => null,
			request: (async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/user/repos")) {
					return new Response(JSON.stringify([
						{ name: "app", full_name: "neko/app", private: true, fork: false, description: "desktop", html_url: "https://github.com/neko/app", language: "TypeScript", stargazers_count: 8, updated_at: "2026-10-01T00:00:00Z" },
						{ name: "bad", full_name: "neko/bad", html_url: "https://evil.example/neko/bad" },
					]), { status: 200, headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } });
				}
				if (url.startsWith("https://avatars.githubusercontent.com/")) {
					return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), { headers: { "content-type": "image/png" } });
				}
				return Response.json({ login: "neko", name: "Neko", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4", html_url: "https://github.com/neko", bio: "hello", public_repos: 2, followers: 3, following: 4 });
			}) as unknown as typeof fetch,
		});
		await store.save("ghp_manual");
		const profile = await store.profile();
		expect(profile.account).toMatchObject({ login: "neko", name: "Neko", publicRepos: 2, followers: 3, following: 4 });
		expect(profile.account.avatarUrl?.startsWith("data:image/png;base64,")).toBe(true);
		expect(profile.repositories.map((repo) => repo.fullName)).toEqual(["neko/app"]);
		expect(profile.repositories[0]).toMatchObject({ private: true, stars: 8, language: "TypeScript" });
		expect(profile.truncated).toBe(true);
	});

	test("profile still returns the account when the repository list is refused", async () => {
		const f = fixture();
		const store = new GitHubCredentialStore({
			userDataDir: f.directory,
			encryption,
			readGhToken: async () => null,
			request: (async (input: RequestInfo | URL) => {
				if (String(input).includes("/user/repos")) return new Response("no", { status: 403 });
				return Response.json({ login: "neko" });
			}) as unknown as typeof fetch,
		});
		await store.save("ghp_manual");
		const profile = await store.profile();
		expect(profile.account.login).toBe("neko");
		expect(profile.repositories).toEqual([]);
		expect(profile.repositoriesWarning).toContain("403");
	});

	test("profile stops waiting when api.github.com never answers, and a stalled repo list still returns the account", async () => {
		const f = fixture();
		writeFileSync(join(f.directory, "github-auth.json"), JSON.stringify({ version: 1, encryptedToken: encryption.encryptString("ghp_manual").toString("base64"), login: "neko" }));
		const stalled = new GitHubCredentialStore({
			userDataDir: f.directory, encryption, readGhToken: async () => null, requestTimeoutMs: 40,
			request: (() => new Promise(() => {})) as unknown as typeof fetch,
		});
		const started = Date.now();
		await expect(stalled.profile()).rejects.toThrow("api.github.com");
		expect(Date.now() - started).toBeLessThan(2_000);

		const partial = new GitHubCredentialStore({
			userDataDir: f.directory, encryption, readGhToken: async () => null, requestTimeoutMs: 40,
			request: (async (input: RequestInfo | URL) => {
				if (String(input).includes("/user/repos")) return new Promise(() => {});
				return Response.json({ login: "neko", name: "Neko" });
			}) as unknown as typeof fetch,
		});
		const profile = await partial.profile();
		expect(profile.account.login).toBe("neko");
		expect(profile.repositories).toEqual([]);
		expect(profile.repositoriesWarning).toContain("api.github.com");
	});

	test("profile requires a configured credential", async () => {
		const f = fixture();
		await expect(f.store.profile()).rejects.toThrow("未配置");
	});

	test("basic_text storage is not offered for new credentials on Linux", () => {
		if (process.platform !== "linux") return;
		const f = fixture();
		const store = new GitHubCredentialStore({ userDataDir: f.directory, encryption: { ...encryption, getSelectedStorageBackend: () => "basic_text" }, readGhToken: async () => null });
		expect(() => store.assertStorage()).toThrow("密钥环不可用");
	});
});
