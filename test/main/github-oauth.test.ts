import { describe, expect, test } from "bun:test";
import { GitHubLoginService, GitHubOAuthClient } from "../../src/main/github-oauth";
import type { GitHubAuthStatus } from "../../src/shared/pullRequests";
import { isWebUiRpcMethod } from "../../src/shared/webui";
import type { GitHubOAuthGrant } from "../../src/shared/github-oauth";

function fixture(options?: { save?: (grant: GitHubOAuthGrant, active: () => boolean) => Promise<GitHubAuthStatus>; storage?: () => void }) {
	let now = Date.now();
	const calls: { path: string; body: Record<string, string>; headers: Headers }[] = [];
	const opened: string[] = [];
	const saved: GitHubOAuthGrant[] = [];
	const complete: GitHubAuthStatus = { configured: true, source: "oauth", login: "neko", encryptionAvailable: true };
	const request = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname.split("/").at(-1)!;
		const body = JSON.parse(String(init?.body)) as Record<string, string>;
		calls.push({ path, body, headers: new Headers(init?.headers) });
		if (path === "start") return Response.json({ id: "a".repeat(43), method: body.method,
			url: body.method === "device" ? "https://github.com/login/device" : "https://github.com/login/oauth/authorize?state=test",
			userCode: body.method === "device" ? "ABCD-EFGH" : undefined, expiresAt: now + 900_000, interval: 5 });
		if (path === "poll") return Response.json({ state: "complete", grant: { method: "browser", credentials: { accessToken: "ghu_test" } } });
		return Response.json({ ok: true });
	}) as unknown as typeof fetch;
	const client = new GitHubOAuthClient(request, "https://test.example", () => now);
	const service = new GitHubLoginService(client, async url => { opened.push(url); }, options?.save ?? (async grant => { saved.push(grant); return complete; }), options?.storage ?? (() => {}), () => now);
	return { service, client, calls, opened, saved, advance: (ms: number) => { now += ms; } };
}

describe("desktop GitHub sign-in", () => {
	test("browser opens externally, IPC contains no secret, and polls are coalesced before safe storage", async () => {
		const f = fixture(); const flow = await f.service.start("browser");
		expect(f.opened).toHaveLength(1);
		expect(flow).not.toHaveProperty("secret");
		const secret = f.calls[0]!.body.secret!;
		expect(secret).toHaveLength(43);
		expect(JSON.stringify(flow)).not.toContain(secret);
		expect((await f.service.poll(flow.id)).state).toBe("pending");
		f.advance(5000);
		const results = await Promise.all([f.service.poll(flow.id), f.service.poll(flow.id)]);
		expect(results.map(r => r.state)).toEqual(["complete", "complete"]);
		expect(f.calls.filter(c => c.path === "poll")).toHaveLength(1);
		expect(f.calls.find(c => c.path === "poll")!.headers.get("authorization")).toBe(`Bearer ${secret}`);
		expect(JSON.stringify(results)).not.toContain("ghu_test");
		expect(f.saved).toHaveLength(1);
	});

	test("device code opens only on the user's request and cancellation prevents further redemption", async () => {
		const f = fixture(); const flow = await f.service.start("device");
		expect(flow.userCode).toBe("ABCD-EFGH"); expect(f.opened).toHaveLength(0);
		await f.service.open(); expect(f.opened).toEqual(["https://github.com/login/device"]);
		f.service.cancel();
		await expect(f.service.poll(flow.id)).rejects.toThrow("授权已取消");
		expect(f.saved).toHaveLength(0);
		expect(f.calls.filter(c => c.path === "cancel")).toHaveLength(1);
	});

	test("cancellation while account verification is pending cannot save credentials", async () => {
		let release!: () => void; let persisted = false;
		const f = fixture({ save: async (_grant, active) => {
			await new Promise<void>(resolve => { release = resolve; });
			if (!active()) throw new Error("cancelled");
			persisted = true;
			return { configured: true, source: "oauth", encryptionAvailable: true };
		} });
		const flow = await f.service.start("browser"); f.advance(5000);
		const pending = f.service.poll(flow.id);
		for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 0));
		expect(release).toBeDefined();
		f.service.cancel(); release();
		await expect(pending).rejects.toThrow("cancelled"); expect(persisted).toBe(false);
	});

	test("unavailable encryption prevents starting any authorization request", async () => {
		const f = fixture({ storage: () => { throw new Error("keyring unavailable"); } });
		await expect(f.service.start("browser")).rejects.toThrow("keyring unavailable");
		expect(f.calls).toHaveLength(0);
	});

	test("does not open an authorization URL outside GitHub", async () => {
		const request = (async () => Response.json({ id: "a".repeat(43), method: "browser", url: "https://evil.example/login", expiresAt: Date.now() + 10_000, interval: 2 })) as unknown as typeof fetch;
		const client = new GitHubOAuthClient(request);
		await expect(client.start("browser", "s".repeat(43))).rejects.toThrow("无效的会话");
	});
});


test("an old flow cannot cancel another flow, and sign-in RPC is desktop-only", async () => {
	const f = fixture(); const flow = await f.service.start("browser");
	f.service.cancel("b".repeat(43));
	f.advance(5000); expect((await f.service.poll(flow.id)).state).toBe("complete");
	for (const method of ["githubAuthorize", "githubPollAuthorization", "githubCancelAuthorization", "githubOpenAuthorization"]) expect(isWebUiRpcMethod(method)).toBe(false);
});
