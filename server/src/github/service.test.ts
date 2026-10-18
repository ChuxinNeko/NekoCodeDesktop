import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GitHubAuthorizationService, type GitHubAppConfig } from "./service";
import type { GitHubAuthorizationDoc, GitHubSessionStore } from "./store";

export class MemoryGitHubStore implements GitHubSessionStore {
	readonly docs = new Map<string, GitHubAuthorizationDoc>();
	async create(doc: GitHubAuthorizationDoc) { this.docs.set(doc._id, structuredClone(doc)); }
	async get(id: string) { return structuredClone(this.docs.get(id) ?? null); }
	async claim(id: string, now: number) {
		const doc = this.docs.get(id);
		if (!doc || !["pending", "installing"].includes(doc.status) || doc.nextPollAt > now || doc.expiresAt.getTime() <= now) return false;
		doc.status = "exchanging";
		return true;
	}
	async update(id: string, patch: Partial<GitHubAuthorizationDoc>) {
		const doc = this.docs.get(id);
		if (doc?.status === "exchanging") Object.assign(doc, structuredClone(patch));
	}
	async take(id: string, secretHash: string, now: number) {
		const doc = this.docs.get(id);
		if (!doc || doc.status !== "ready" || doc.secretHash !== secretHash || doc.expiresAt.getTime() <= now) return null;
		this.docs.delete(id); return structuredClone(doc);
	}
	async remove(id: string) { this.docs.delete(id); }
}

export const config: GitHubAppConfig = { clientId: "test-client", clientSecret: "server-only-secret", callbackUrl: "https://codeapi.example/github/auth/callback", appSlug: "nekocode-test", encryptionKey: "a-long-test-encryption-key-at-least-32-characters" };
export const secret = "s".repeat(43);
const tokens = { access_token: "ghu_test", refresh_token: "ghr_test", expires_in: 28_800, refresh_token_expires_in: 15_897_600 };
const device = { device_code: "private-device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };

function fixture() {
	let now = 1_800_000_000_000;
	const store = new MemoryGitHubStore();
	const calls: { url: string; body: URLSearchParams }[] = [];
	const replies: unknown[] = [];
	let installed = true;
	const request = (async (url: string | URL | Request, options?: RequestInit) => {
		if (String(url).startsWith("https://api.github.com")) return Response.json(String(url).includes("/repositories?") ? { repositories: installed ? [{ id: 1 }] : [] } : { installations: installed ? [{ id: 42 }] : [] });
		calls.push({ url: String(url), body: new URLSearchParams(String(options?.body)) });
		return Response.json(replies.shift() ?? tokens);
	}) as unknown as typeof fetch;
	const service = new GitHubAuthorizationService(config, store, request, () => now);
	return { service, store, calls, replies, setInstalled: (value: boolean) => { installed = value; }, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("GitHub browser authorization", () => {
	test("binds callback state and PKCE, encrypts handoff, and requires the independent secret to redeem exactly once", async () => {
		const f = fixture();
		const flow = await f.service.start("browser", secret);
		const url = new URL(flow.url);
		expect(url.searchParams.get("state")).toBe(flow.id);
		expect(url.searchParams.get("client_id")).toBe(config.clientId);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(flow).not.toHaveProperty("secret");
		expect(JSON.stringify(f.store.docs.get(flow.id))).not.toContain(secret);
		await expect(f.service.callback("wrong-state", "code")).rejects.toThrow("授权链接无效");
		await f.service.callback(flow.id, "one-use-code");
		const exchange = f.calls[0]!.body;
		expect(exchange.get("client_secret")).toBe(config.clientSecret);
		expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge")!);
		expect(JSON.stringify(f.store.docs.get(flow.id))).not.toContain("ghu_test");
		expect(JSON.stringify(f.store.docs.get(flow.id))).not.toContain("ghr_test");
		await expect(f.service.poll(flow.id, flow.id)).rejects.toThrow("无法访问");
		const results = await Promise.allSettled([f.service.poll(flow.id, secret), f.service.poll(flow.id, secret)]);
		expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
		const result = results.find(r => r.status === "fulfilled");
		if (result?.status !== "fulfilled" || result.value.state !== "complete") throw new Error("missing grant");
		expect(result.value.grant.credentials.accessToken).toBe("ghu_test");
		expect(result.value.grant.credentials.expiresAt).toBe(f.now() + 28_800_000);
		expect(f.store.docs.size).toBe(0);
		await expect(f.service.callback(flow.id, "replayed-code")).rejects.toThrow();
		expect(f.calls).toHaveLength(1);
	});

	test("denial ends the session without leaking provider error text", async () => {
		const f = fixture(); const flow = await f.service.start("browser", secret);
		await expect(f.service.callback(flow.id, undefined, "secret-in-upstream-description")).rejects.toThrow("授权已取消");
		await expect(f.service.poll(flow.id, secret)).rejects.toThrow("授权已取消");
		expect(f.calls).toHaveLength(0);
	});

	test("cancelling during the token exchange cannot recreate a deleted session", async () => {
		const store = new MemoryGitHubStore();
		let release!: (response: Response) => void;
		const pending = new Promise<Response>(resolve => { release = resolve; });
		const service = new GitHubAuthorizationService(config, store, (() => pending) as unknown as typeof fetch);
		const flow = await service.start("browser", secret);
		const callback = service.callback(flow.id, "code");
		// Let the callback acquire its persistent claim before cancelling it.
		await Promise.resolve(); await Promise.resolve();
		await service.cancel(flow.id, secret);
		release(Response.json(tokens)); await callback;
		expect(store.docs.size).toBe(0);
		await expect(service.poll(flow.id, secret)).rejects.toThrow();
	});

	test("expired sessions cannot exchange codes, even before Mongo's TTL cleanup", async () => {
		const f = fixture(); const flow = await f.service.start("browser", secret); f.advance(900_001);
		await expect(f.service.callback(flow.id, "code")).rejects.toThrow();
		await expect(f.service.poll(flow.id, secret)).rejects.toThrow("过期");
		expect(f.calls).toHaveLength(0);
	});
});

describe("GitHub device authorization", () => {
	test("enforces interval and slow_down across concurrent polls; never returns device_code", async () => {
		const f = fixture(); f.replies.push(device);
		const flow = await f.service.start("device", secret);
		expect(flow.userCode).toBe("ABCD-EFGH");
		expect(JSON.stringify(flow)).not.toContain("private-device-code");
		expect(JSON.stringify([...f.store.docs.values()])).not.toContain("private-device-code");
		await f.service.poll(flow.id, secret); expect(f.calls).toHaveLength(1);
		f.advance(5000); f.replies.push({ error: "authorization_pending" });
		await Promise.all([f.service.poll(flow.id, secret), f.service.poll(flow.id, secret)]);
		expect(f.calls).toHaveLength(2);
		f.advance(5000); f.replies.push({ error: "slow_down" });
		expect(await f.service.poll(flow.id, secret)).toEqual({ state: "pending", interval: 10 });
		f.advance(5000); await f.service.poll(flow.id, secret); expect(f.calls).toHaveLength(3);
		f.advance(5000); const result = await f.service.poll(flow.id, secret);
		expect(result.state).toBe("complete");
		expect(f.calls[3]!.body.get("device_code")).toBe(device.device_code);
		expect(f.calls[3]!.body.has("client_secret")).toBe(false);
	});

	test("does not send users to an untrusted verification URI", async () => {
		const f = fixture(); f.replies.push({ ...device, verification_uri: "https://evil.example/device" });
		await expect(f.service.start("device", secret)).rejects.toThrow("无效的设备码");
		expect(f.store.docs.size).toBe(0);
	});

	test("device denial is terminal and is not polled again", async () => {
		const f = fixture(); f.replies.push(device); const flow = await f.service.start("device", secret);
		f.advance(5000); f.replies.push({ error: "access_denied", error_description: "do not echo secret" });
		await expect(f.service.poll(flow.id, secret)).rejects.toThrow("授权已取消");
		await expect(f.service.poll(flow.id, secret)).rejects.toThrow("授权已取消");
		expect(f.calls).toHaveLength(2);
	});
});

test("refresh uses the server-side secret; revocation returns an actionable error", async () => {
	const f = fixture(); const credentials = await f.service.refresh("ghr_old");
	expect(credentials.refreshToken).toBe("ghr_test");
	expect(f.calls[0]!.body.get("client_secret")).toBe(config.clientSecret);
	expect(f.calls[0]!.body.get("grant_type")).toBe("refresh_token");
	f.replies.push({ error: "bad_refresh_token", error_description: "ghr-secret" });
	await expect(f.service.refresh("ghr_revoked")).rejects.toThrow("重新授权");
});

test("unconfigured servers fail gracefully before making GitHub calls", async () => {
	const service = new GitHubAuthorizationService(undefined, new MemoryGitHubStore());
	await expect(service.start("browser", secret)).rejects.toThrow("尚未配置");
});

for (const method of ["browser", "device"] as const) {
	test(`${method}: credentials stay encrypted and pending until installation grants repository access`, async () => {
		const f = fixture(); f.setInstalled(false);
		if (method === "device") f.replies.push(device);
		const flow = await f.service.start(method, secret);
		if (method === "browser") expect(await f.service.callback(flow.id, "code")).toBe(flow.installationUrl);
		else { f.advance(5000); await f.service.poll(flow.id, secret); }
		expect(f.store.docs.get(flow.id)?.status).toBe("installing");
		if (method === "browser") {
			f.advance(5000);
			await expect(f.service.callback(flow.id, "replayed-code")).rejects.toThrow("授权链接无效");
			expect(f.store.docs.get(flow.id)?.status).toBe("installing");
		}
		expect(JSON.stringify(f.store.docs.get(flow.id))).not.toContain("ghu_test");
		const pending = await f.service.poll(flow.id, secret);
		expect(pending.state).toBe("pending");
		if (method === "device") expect(pending).toHaveProperty("url", flow.installationUrl);
		const exchanges = f.calls.length;
		f.advance(5000); await f.service.poll(flow.id, secret);
		expect(f.calls).toHaveLength(exchanges);
		f.setInstalled(true); f.advance(5000);
		expect((await f.service.poll(flow.id, secret)).state).toBe("complete");
		expect(f.store.docs.size).toBe(0);
	});
}

test("cancelled and expired installation sessions cannot release credentials", async () => {
	const f = fixture(); f.setInstalled(false);
	const flow = await f.service.start("browser", secret); await f.service.callback(flow.id, "code");
	await f.service.cancel(flow.id, secret); f.setInstalled(true);
	await expect(f.service.poll(flow.id, secret)).rejects.toThrow();
	f.setInstalled(false);
	const expired = await f.service.start("browser", secret); await f.service.callback(expired.id, "code");
	f.advance(900_001); f.setInstalled(true);
	await expect(f.service.poll(expired.id, secret)).rejects.toThrow("过期");
});
