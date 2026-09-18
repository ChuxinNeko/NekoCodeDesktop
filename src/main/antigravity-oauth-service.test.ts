import { describe, expect, test } from "bun:test";
import { AntigravityOAuthService } from "./antigravity-oauth-service";
import type { OAuthLoginEvent } from "../shared/settings";
import type { StoredOAuthAccount, StoredOAuthCredential } from "./oauth-credential-store";
import type { FetchLike } from "./antigravity";

function fixture(overrides: { fetch?: FetchLike; timeout?: number; noEncryption?: boolean; callbackFailure?: boolean } = {}) {
	let credential: StoredOAuthCredential | undefined;
	let account: (StoredOAuthAccount & { expiresAt: number }) | undefined;
	let writes = 0;
	let closed = false;
	let opened = "";
	const events: OAuthLoginEvent[] = [];
	const calls: string[] = [];
	let settle!: (code: string | null) => void;
	const code = new Promise<string | null>((resolve) => { settle = resolve; });
	let ready!: () => void;
	const started = new Promise<void>((resolve) => { ready = resolve; });
	const store = {
		account: () => account,
		has: () => credential !== undefined,
		read: () => credential,
		assertEncryptionAvailable: () => { if (overrides.noEncryption) throw new Error("密钥环不可用"); },
		write: (_id: string, next: StoredOAuthCredential, info: StoredOAuthAccount) => {
			writes++; credential = next; account = { ...info, expiresAt: next.expiresAt };
		},
		delete: () => { credential = undefined; account = undefined; },
	};
	const service = new AntigravityOAuthService({
		store,
		fetch: overrides.fetch ?? (async (input) => {
			const url = String(input); calls.push(url);
			if (url.includes("/token")) return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 });
			if (url.includes("manifest")) return new Response("version: 2.9.1");
			if (url.includes("userinfo")) return Response.json({ email: "person@example.com" });
			if (url.endsWith(":loadCodeAssist")) return Response.json({ project: "project-123" });
			throw new Error("Unexpected network call");
		}),
		openExternal: (url) => { opened = url; ready(); },
		emit: (event) => events.push(event),
		startCallback: async (options) => {
			if (overrides.callbackFailure) throw new Error("端口 51121 不可用");
			expect(options.port).toBe(51121);
			expect(options.path).toBe("/oauth-callback");
			expect(options.state).toMatch(/^[a-f0-9]{32}$/);
			return { port: options.port, waitForCode: () => code, submit: settle, cancel: () => settle(null), close: () => { closed = true; settle(null); } };
		},
		loginTimeoutMs: overrides.timeout,
	});
	return { service, store, events, calls, settle, started, get opened() { return opened; }, get closed() { return closed; }, get writes() { return writes; } };
}

describe("Antigravity account lifecycle", () => {
	test("model requests use daily streaming with pinned identity and are invalidated by logout", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const f = fixture({ fetch: async (input, init) => {
			calls.push({ url: String(input), init });
			return String(input).includes("manifest") ? new Response("version: 2.9.1") : new Response("", { headers: { "content-type": "text/event-stream" } });
		} });
		f.store.write("antigravity", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600000 }, { email: "user@example.com", projectId: "project", signedInAt: 1 });
		const auth = await f.service.requestContext();
		const payload = { project: "project", model: "gemini-3-flash", request: { contents: [] } };
		await f.service.sendModelRequest(payload, auth);
		expect(calls[1]).toMatchObject({ url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", init: {
			method: "POST", headers: { Authorization: "Bearer access", "Content-Type": "application/json", "User-Agent": "antigravity/hub/2.9.1 darwin/arm64" }, body: JSON.stringify(payload),
		} });
		expect(calls[1]!.init?.signal).toBe(auth.signal);
		f.service.logout();
		expect(auth.signal.aborted).toBe(true);
		expect(() => f.service.sendModelRequest(payload, auth)).toThrow();
		expect(calls).toHaveLength(2);
	});
	test("completes OAuth atomically and only exposes non-secret account fields", async () => {
		const f = fixture();
		const login = f.service.login();
		await f.started;
		expect(new URL(f.opened).hostname).toBe("accounts.google.com");
		f.settle("code");
		const summary = await login;
		expect(summary).toMatchObject({ id: "antigravity", signedIn: true, email: "person@example.com", projectId: "project-123" });
		expect(summary.modelIds).toContain("claude-sonnet-4-6");
		expect(f.calls).toHaveLength(4);
		expect(f.writes).toBe(1);
		expect(f.closed).toBe(true);
		expect(JSON.stringify(f.events)).not.toContain("access-secret");
		expect(JSON.stringify(f.events)).not.toContain("refresh-secret");
		expect(f.events.at(-1)?.kind).toBe("done");
	});

	test("cancel, duplicate login and logout do not leave a callback or commit a credential", async () => {
		const f = fixture();
		const login = f.service.login();
		await f.started;
		await expect(f.service.login()).rejects.toThrow("正在登录");
		f.service.cancel();
		await expect(login).rejects.toThrow();
		expect(f.events.at(-1)?.kind).toBe("cancelled");
		expect(f.writes).toBe(0);
		expect(f.calls).toHaveLength(0);
		expect(f.closed).toBe(true);
		expect(f.service.logout().signedIn).toBe(false);
	});

	test("timeout closes the callback and reports an error", async () => {
		const f = fixture({ timeout: 10 });
		await expect(f.service.login()).rejects.toThrow("超时");
		expect(f.events.at(-1)?.kind).toBe("error");
		expect(f.closed).toBe(true);
	});

	test("occupied port or unavailable encryption fails before browser or network", async () => {
		for (const options of [{ noEncryption: true }, { callbackFailure: true }]) {
			const f = fixture(options);
			await expect(f.service.login()).rejects.toThrow();
			expect(f.opened).toBe("");
			expect(f.calls).toHaveLength(0);
			expect(f.writes).toBe(0);
		}
	});

	test("project discovery failure does not replace the previous account", async () => {
		const f = fixture({ fetch: async (input) => {
			const url = String(input);
			if (url.includes("/token")) return Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 });
			if (url.includes("manifest")) return new Response("version: 2.9.1");
			if (url.includes("userinfo")) return Response.json({ email: "new@example.com" });
			return new Response("DENIED", { status: 403 });
		} });
		f.store.write("antigravity", { accessToken: "old", refreshToken: "old-refresh", expiresAt: 123 }, { email: "old@example.com", projectId: "old", signedInAt: 1 });
		const login = f.service.login(); await f.started; f.settle("code");
		await expect(login).rejects.toThrow("403");
		expect(f.service.list().email).toBe("old@example.com");
		expect(f.writes).toBe(1);
	});

	test("concurrent refreshes share one exchange and retain the refresh token", async () => {
		let exchanges = 0;
		const f = fixture({ fetch: async () => { exchanges++; return Response.json({ access_token: "new", expires_in: 3600 }); } });
		f.store.write("antigravity", { accessToken: "old", refreshToken: "retained", expiresAt: 1 }, { projectId: "p", signedInAt: 1 });
		const [a, b] = await Promise.all([f.service.getValidCredential(), f.service.getValidCredential()]);
		expect(a).toEqual(b);
		expect(a.refreshToken).toBe("retained");
		expect(exchanges).toBe(1);
		await f.service.refresh();
		expect(exchanges).toBe(1);
	});

	test("logout prevents an in-flight refresh from resurrecting the credential", async () => {
		let release!: (response: Response) => void;
		const f = fixture({ fetch: () => new Promise((resolve) => { release = resolve; }) });
		f.store.write("antigravity", { accessToken: "old", refreshToken: "old-refresh", expiresAt: 1 }, { projectId: "p", signedInAt: 1 });
		const refresh = f.service.getValidCredential();
		f.service.logout();
		release(Response.json({ access_token: "new", expires_in: 3600 }));
		await expect(refresh).rejects.toThrow();
		expect(f.service.list().signedIn).toBe(false);
		expect(f.writes).toBe(1);
	});
});
