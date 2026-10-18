import { Elysia, t } from "elysia";
import type { Env } from "../env";
import type { Database } from "../db";
import { clientIp, RateLimiter } from "../rate-limit";
import { GitHubAuthorizationError, GitHubAuthorizationService } from "./service";
import { MongoGitHubSessionStore } from "./store";

const idSchema = t.String({ pattern: "^[A-Za-z0-9_-]{43}$" });
const sessionBody = t.Object({ id: idSchema });
const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export function githubRoutes(deps: { db: Pick<Database, "githubAuthorizations">; env: Pick<Env, "github"> }, injected?: GitHubAuthorizationService) {
	const service = injected ?? new GitHubAuthorizationService(deps.env.github, new MongoGitHubSessionStore(deps.db.githubAuthorizations));
	const starts = new RateLimiter(10, 5 * 60_000);
	const polls = new RateLimiter(120, 60_000);
	const refreshes = new RateLimiter(30, 10 * 60_000);

	async function run(request: Request, limiter: RateLimiter, action: () => Promise<unknown>): Promise<Response> {
		const ip = clientIp(Object.fromEntries(request.headers));
		if (!limiter.take(ip)) return Response.json({ error: { code: "too_many_requests", message: "请求过于频繁，请稍后重试。" } }, { status: 429, headers: { ...noStore, "retry-after": String(limiter.retryAfter(ip)) } });
		try { return Response.json(await action(), { headers: noStore }); }
		catch (error) {
			const known = error instanceof GitHubAuthorizationError;
			return Response.json({ error: { code: known ? error.code : "server_error", message: known ? error.message : "授权服务暂时不可用，请稍后重试。" } }, { status: known ? error.status : 500, headers: noStore });
		}
	}

	function secret(request: Request): string {
		const value = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
		if (!value) throw new GitHubAuthorizationError("unauthorized", "缺少授权会话凭据。", 401);
		return value;
	}

	return new Elysia({ prefix: "/github/auth" })
		.post("/start", ({ request, body }) => run(request, starts, () => service.start(body.method, body.secret)), {
			body: t.Object({ method: t.Union([t.Literal("browser"), t.Literal("device")]), secret: idSchema }),
		})
		.post("/poll", ({ request, body }) => run(request, polls, () => service.poll(body.id, secret(request))), { body: sessionBody })
		.post("/cancel", ({ request, body }) => run(request, polls, async () => { await service.cancel(body.id, secret(request)); return { ok: true }; }), { body: sessionBody })
		.post("/refresh", ({ request, body }) => run(request, refreshes, () => service.refresh(body.refreshToken)), {
			body: t.Object({ refreshToken: t.String({ minLength: 1, maxLength: 4096, pattern: "^\\S+$" }) }),
		})
		.get("/callback", async ({ query }) => {
			let success = false;
			try {
				const installationUrl = await service.callback(query.state ?? "", query.code, query.error);
				if (installationUrl) return new Response(null, { status: 303, headers: { ...noStore, location: installationUrl } });
				success = true;
			} catch { /* Never echo GitHub query strings or secrets into HTML. */ }
			return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NekoCode · GitHub</title><body><h1>${success ? "GitHub 授权已完成" : "GitHub 授权未完成"}</h1><p>${success ? "账号授权和仓库连接已完成，请返回 NekoCode。你可以关闭此页面。" : "授权已取消、过期或发生错误。请返回 NekoCode 查看提示并重新连接。"}</p></body></html>`, {
				status: success ? 200 : 400,
				headers: { ...noStore, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", "x-content-type-options": "nosniff" },
			});
		}, { query: t.Object({ state: t.Optional(t.String({ maxLength: 128 })), code: t.Optional(t.String({ maxLength: 4096 })), error: t.Optional(t.String({ maxLength: 128 })) }) });
}
