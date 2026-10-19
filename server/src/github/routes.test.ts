import { expect, test } from "bun:test";
import { githubRoutes } from "./routes";
import { GitHubAuthorizationService } from "./service";
import type { Database } from "../db";
import type { Env } from "../env";
import type { GitHubAuthorizationDoc, GitHubSessionStore } from "./store";

function fixture(configured = true, installed = true) {
	const docs = new Map<string, GitHubAuthorizationDoc>();
	const store: GitHubSessionStore = {
		create: async d => { docs.set(d._id, structuredClone(d)); },
		get: async id => structuredClone(docs.get(id) ?? null),
		claim: async (id, now) => { const d = docs.get(id); if (!d || !["pending", "installing"].includes(d.status) || d.expiresAt.getTime() <= now || d.nextPollAt > now) return false; d.status = "exchanging"; return true; },
		update: async (id, patch) => { const d = docs.get(id); if (d?.status === "exchanging") Object.assign(d, patch); },
		take: async (id, hash, now) => { const d = docs.get(id); if (!d || d.status !== "ready" || d.secretHash !== hash || d.expiresAt.getTime() <= now) return null; docs.delete(id); return d; },
		remove: async id => { docs.delete(id); },
	};
	const config = { clientId: "id", clientSecret: "server-secret", callbackUrl: "https://codeapi.example/github/auth/callback", appSlug: "neko-test", encryptionKey: "encryption-key-at-least-32-characters-long" };
	const service = new GitHubAuthorizationService(configured ? config : undefined, store, (async (url: string) => String(url).startsWith("https://api.github.com") ? Response.json(String(url).includes("/repositories?") ? { repositories: [{ id: 1 }] } : { installations: installed ? [{ id: 42 }] : [] }) : Response.json({ access_token: "ghu_secret", refresh_token: "ghr_secret", expires_in: 28_800 })) as unknown as typeof fetch);
	const app = githubRoutes({ db: {} as Pick<Database, "githubAuthorizations">, env: {} as Pick<Env, "github" | "githubProxy"> }, service);
	const secret = "s".repeat(43);
	const post = (path: string, body: unknown, bearer?: string) => app.handle(new Request(`http://localhost/github/auth/${path}`, {
		method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
	}));
	return { app, post, secret, docs };
}

test("browser callback uses no-store HTML and does not reflect query values or tokens", async () => {
	const f = fixture();
	const started = await f.post("start", { method: "browser", secret: f.secret });
	expect(started.status).toBe(200); expect(started.headers.get("cache-control")).toBe("no-store");
	const flow = await started.json() as { id: string };
	const unauthorized = await f.post("poll", { id: flow.id }); expect(unauthorized.status).toBe(401);
	const callback = await f.app.handle(new Request(`http://localhost/github/auth/callback?state=${flow.id}&code=${encodeURIComponent('<script>alert(1)</script>')}`));
	expect(callback.status).toBe(200);
	expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
	expect(callback.headers.get("content-security-policy")).toContain("default-src 'none'");
	const html = await callback.text(); expect(html).not.toContain("<script>"); expect(html).not.toContain("ghu_secret");
	const granted = await f.post("poll", { id: flow.id }, f.secret);
	expect(granted.status).toBe(200); expect(((await granted.json()) as { grant: { credentials: { accessToken: string } } }).grant.credentials.accessToken).toBe("ghu_secret");
	expect((await f.post("poll", { id: flow.id }, f.secret)).status).toBe(401);
});

test("unknown/cancelled callbacks fail without redirecting to a caller-controlled URL", async () => {
	const f = fixture();
	const response = await f.app.handle(new Request("http://localhost/github/auth/callback?state=unknown&error=https%3A%2F%2Fevil.example"));
	expect(response.status).toBe(400); expect(response.headers.get("location")).toBe(null);
	expect(await response.text()).not.toContain("evil.example");
});

test("public starts are rate limited and return Retry-After", async () => {
	const f = fixture();
	for (let i = 0; i < 10; i++) expect((await f.post("start", { method: "browser", secret: f.secret })).status).toBe(200);
	const limited = await f.post("start", { method: "browser", secret: f.secret });
	expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
});

test("unconfigured GitHub App is an explicit 503, not a server crash", async () => {
	const f = fixture(false); const response = await f.post("start", { method: "browser", secret: f.secret });
	expect(response.status).toBe(503); expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_configured");
});


test("first browser consent redirects directly to GitHub repository selection and keeps desktop pending", async () => {
	const f = fixture(true, false);
	const flow = await (await f.post("start", { method: "browser", secret: f.secret })).json() as { id: string };
	const response = await f.app.handle(new Request(`http://localhost/github/auth/callback?state=${flow.id}&code=code`));
	expect(response.status).toBe(303);
	expect(response.headers.get("location")).toBe("https://github.com/apps/neko-test/installations/new");
	expect(response.headers.get("cache-control")).toBe("no-store");
	const pending = await (await f.post("poll", { id: flow.id }, f.secret)).json();
	expect(pending).toHaveProperty("state", "pending");
	expect(JSON.stringify(pending)).not.toContain("ghu_secret");
});
