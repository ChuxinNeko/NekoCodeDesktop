import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet, request as httpRequest, type Server } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { WebUiService } from "./webui-service";
import { DEFAULT_SHELL_INFO } from "../shared/window";
import type { WebUiRpcMethod } from "../shared/webui";

const fixtures: Array<{ service: WebUiService; dirs: string[] }> = [];
const upstreams: Server[] = [];
afterEach(async () => {
	for (const { service, dirs } of fixtures.splice(0)) {
		await service.stop();
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	}
	for (const server of upstreams.splice(0)) {
		await new Promise<void>((done) => {
			server.close(() => done());
			server.closeAllConnections();
		});
	}
});

function setup(
	invoke?: (method: WebUiRpcMethod, args: unknown[]) => Promise<unknown>,
	rendererDevUrl?: string,
) {
	const userDataDir = mkdtempSync(join(tmpdir(), "nekocode-webui-data-"));
	const rendererDir = mkdtempSync(join(tmpdir(), "nekocode-webui-renderer-"));
	writeFileSync(
		join(rendererDir, "index.html"),
		'<!doctype html><html lang="en" data-runtime="electron"><head><title>t</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>',
	);
	mkdirSync(join(rendererDir, "assets"));
	writeFileSync(join(rendererDir, "assets", "index.js"), "console.log(1);\n");
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const service = new WebUiService({
		userDataDir,
		rendererDir,
		...(rendererDevUrl ? { rendererDevUrl } : {}),
		homeDir: "/home/tester",
		shell: DEFAULT_SHELL_INFO,
		invoke:
			invoke ??
			(async (method, args) => {
				calls.push({ method, args });
				return { echoed: method };
			}),
	});
	fixtures.push({ service, dirs: [userDataDir, rendererDir] });
	const url = () => service.status().urls[0];
	const cookieOf = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
	return { service, userDataDir, url, calls, cookieOf };
}

const PASSWORD = "correct horse battery";

async function login(url: string, password = PASSWORD): Promise<Response> {
	return fetch(`${url}/api/login`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `password=${encodeURIComponent(password)}`,
		redirect: "manual",
	});
}

async function startWithPassword() {
	const f = setup();
	await f.service.save({
		enabled: true,
		host: "localhost",
		port: null,
		password: PASSWORD,
		securePathEnabled: true,
	});
	return f;
}

describe("WebUiService configuration", () => {
	test("defaults to disabled and refuses to enable without a password", async () => {
		const f = setup();
		const status = f.service.status();
		expect(status.enabled).toBe(false);
		expect(status.running).toBe(false);
		expect(status.hasPassword).toBe(false);
		expect(status.port).toBeNull();
		await expect(
			f.service.save({ enabled: true, host: "localhost", port: null, securePathEnabled: true }),
		).rejects.toThrow();
		expect(f.service.status().running).toBe(false);
	});

	test("saving a password and enabling starts on a random localhost port", async () => {
		const f = await startWithPassword();
		const status = f.service.status();
		expect(status.running).toBe(true);
		expect(status.port).not.toBeNull();
		expect(status.securePathEnabled).toBe(true);
		const pathname = new URL(status.urls[0]).pathname;
		expect(pathname).toMatch(/^\/[a-z0-9]{6}$/);
		expect(status.urls).toEqual([`http://localhost:${status.port}${pathname}`]);
	});

	test("a legacy webui.json migrates to a persisted secure path", async () => {
		const f = setup();
		writeFileSync(
			join(f.userDataDir, "webui.json"),
			JSON.stringify({ enabled: false, host: "localhost", port: null }),
		);
		const migrated = new WebUiService({
			userDataDir: f.userDataDir,
			rendererDir: f.userDataDir,
			homeDir: "/home/tester",
			shell: DEFAULT_SHELL_INFO,
			invoke: async () => null,
		});
		fixtures.push({ service: migrated, dirs: [] });
		expect(migrated.status().securePathEnabled).toBe(true);
		const written = JSON.parse(readFileSync(join(f.userDataDir, "webui.json"), "utf8"));
		expect(written.accessPath).toMatch(/^[a-z0-9]{6}$/);
		expect(written.securePathEnabled).toBe(true);
		await migrated.save({ enabled: true, host: "localhost", port: null, password: PASSWORD, securePathEnabled: true });
		const pathname = new URL(migrated.status().urls[0]).pathname;
		expect(pathname).toBe(`/${written.accessPath}`);
		const reloaded = new WebUiService({
			userDataDir: f.userDataDir,
			rendererDir: f.userDataDir,
			homeDir: "/home/tester",
			shell: DEFAULT_SHELL_INFO,
			invoke: async () => null,
		});
		fixtures.push({ service: reloaded, dirs: [] });
		await reloaded.startConfigured();
		expect(new URL(reloaded.status().urls[0]).pathname).toBe(pathname);
	});

	test("webui.json never contains the plaintext password and status hides the hash", async () => {
		const f = await startWithPassword();
		const file = readFileSync(join(f.userDataDir, "webui.json"), "utf8");
		expect(file).not.toContain(PASSWORD);
		const saved = JSON.parse(file);
		expect(saved.passwordHash).toMatch(/^[a-f0-9]{64}$/);
		expect(saved.accessPath).toMatch(/^[a-z0-9]{6}$/);
		const serialized = JSON.stringify(f.service.status());
		expect(serialized).not.toContain("passwordHash");
		expect(serialized).not.toContain("passwordSalt");
	});
});

describe("WebUiService authentication", () => {
	test("unauthenticated requests redirect or fail", async () => {
		const f = await startWithPassword();
		const root = await fetch(f.url(), { redirect: "manual" });
		expect(root.status).toBe(303);
		const base = new URL(f.url()).pathname;
		expect(root.headers.get("location")).toBe(`${base}/login`);
		const rpc = await fetch(`${f.url()}/api/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method: "appVersion", args: [] }),
		});
		expect(rpc.status).toBe(401);
		const page = await fetch(`${f.url()}/login`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("访问密码");
	});

	test("wrong password is 401; the right one sets the session cookie", async () => {
		const f = await startWithPassword();
		const bad = await login(f.url(), "wrong-password");
		expect(bad.status).toBe(401);
		const good = await login(f.url());
		expect(good.status).toBe(303);
		const cookie = good.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("nekocode_webui=");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Max-Age=43200");
		expect(good.headers.get("location")).toBe(`${new URL(f.url()).pathname}/`);
	});

	test("authenticated root serves the injected index and assets", async () => {
		const f = await startWithPassword();
		const cookie = f.cookieOf(await login(f.url()));
		const root = await fetch(f.url(), { headers: { cookie } });
		const html = await root.text();
		expect(root.status).toBe(200);
		expect(html).toContain('data-runtime="web"');
		const base = new URL(f.url()).pathname;
		expect(html).toContain(`<script src="${base}/webui-runtime.js"></script>`);
		const runtime = await fetch(`${f.url()}/webui-runtime.js`, { headers: { cookie } });
		const js = await runtime.text();
		expect(js).toContain("__NEKOCODE_WEBUI__");
		expect(js).toContain('"runtime":"web"');
		expect(js).toContain(`"basePath":"${base}"`);
		const asset = await fetch(`${f.url()}/assets/index.js`, { headers: { cookie } });
		expect(asset.status).toBe(200);
		expect(asset.headers.get("content-type")).toContain("javascript");
	});
});

describe("WebUiService host and origin checks", () => {
	test("hostile Host and Origin headers are rejected", async () => {
		const f = await startWithPassword();
		const port = f.service.status().port!;
		const hostileHost = await new Promise<number>((resolve) => {
			httpGet({ host: "127.0.0.1", port, path: `${new URL(f.url()).pathname}/login`, headers: { Host: "evil.example" } }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
		});
		expect(hostileHost).toBe(403);
		const badOrigin = await fetch(`${f.url()}/login`, {
			headers: { Origin: "http://evil.example" },
		});
		expect(badOrigin.status).toBe(403);
	});

	test("the login POST tolerates an opaque Origin but still rejects cross-site and RPC forgery", async () => {
		const f = await startWithPassword();
		const opaque = await fetch(`${f.url()}/api/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "null",
				"Sec-Fetch-Site": "same-origin",
			},
			body: `password=${encodeURIComponent(PASSWORD)}`,
			redirect: "manual",
		});
		expect(opaque.status).toBe(303);
		expect(opaque.headers.get("set-cookie") ?? "").toContain("nekocode_webui=");

		const crossSite = await fetch(`${f.url()}/api/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "http://evil.example",
				"Sec-Fetch-Site": "cross-site",
			},
			body: `password=${encodeURIComponent(PASSWORD)}`,
			redirect: "manual",
		});
		expect(crossSite.status).toBe(403);

		const cookie = f.cookieOf(await login(f.url()));
		const forgedRpc = await fetch(`${f.url()}/api/rpc`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://evil.example",
				cookie,
			},
			body: JSON.stringify({ method: "appVersion", args: [] }),
		});
		expect(forgedRpc.status).toBe(403);
	});
});

describe("WebUiService RPC", () => {
	test("allowlisted methods reach invoke; everything else is refused", async () => {
		const f = await startWithPassword();
		const cookie = f.cookieOf(await login(f.url()));
		const call = (method: string, args: unknown[] = []) =>
			fetch(`${f.url()}/api/rpc`, {
				method: "POST",
				headers: { "Content-Type": "application/json", cookie },
				body: JSON.stringify({ method, args }),
			});
		const ok = await call("appVersion");
		expect(await ok.json()).toEqual({ ok: true, result: { echoed: "appVersion" } });
		expect(f.calls).toEqual([{ method: "appVersion", args: [] }]);
		for (const method of ["onAgentSnapshot", "webUiSave", "webUiStatus", "openExternal", "setTheme", "pickDirectory", "lanAddProject", "qqBotChooseProject", "noSuchMethod"]) {
			const response = await call(method);
			expect(response.status).toBe(403);
		}
		const allowed = await call("directoryList", ["C:\\"]);
		expect((await allowed.json()).ok).toBe(true);
		expect(f.calls.some((entry) => entry.method === "directoryList")).toBe(true);
		const register = await call("relayRegister", [{ email: "neko@example.com", password: "password-123" }]);
		expect((await register.json()).ok).toBe(true);
		expect(f.calls.some((entry) => entry.method === "relayRegister")).toBe(true);
		const badArgs = await fetch(`${f.url()}/api/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json", cookie },
			body: JSON.stringify({ method: "appVersion", args: "nope" }),
		});
		expect(badArgs.status).toBe(400);
	});

	test("the dev proxy ignores the origin in an absolute-form request target", async () => {
		const seen: string[] = [];
		const upstream = createServer((req, res) => {
			seen.push(`${req.method} ${req.url}`);
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("upstream-body");
		});
		upstreams.push(upstream);
		await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
		const upstreamPort = (upstream.address() as { port: number }).port;
		const f = setup(undefined, `http://127.0.0.1:${upstreamPort}`);
		await f.service.save({ enabled: true, host: "localhost", port: null, password: PASSWORD, securePathEnabled: true });
		const cookie = f.cookieOf(await login(f.url()));
		const port = f.service.status().port!;
		const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port,
					method: "GET",
					path: "http://evil.example/assets/index.js",
					headers: { Host: `localhost:${port}`, cookie },
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
				},
			);
			req.on("error", reject);
			req.end();
		});
		expect(status).toBe(200);
		expect(body).toBe("upstream-body");
		expect(seen).toEqual(["GET /assets/index.js"]);
	});

	test("a failing invoke still returns a parseable JSON error", async () => {
		const f = setup(async () => {
			throw new Error("backend exploded");
		});
		await f.service.save({ enabled: true, host: "localhost", port: null, password: PASSWORD, securePathEnabled: true });
		const cookie = f.cookieOf(await login(f.url()));
		const response = await fetch(`${f.url()}/api/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json", cookie },
			body: JSON.stringify({ method: "appVersion", args: [] }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: false, error: "backend exploded" });
	});
});

describe("WebUiService lifecycle", () => {
	test("changing the password invalidates existing sessions; disabling stops the server", async () => {
		const f = await startWithPassword();
		const cookie = f.cookieOf(await login(f.url()));
		const before = await fetch(`${f.url()}/api/events`, { headers: { cookie } });
		expect(before.status).toBe(200);
		await before.body?.cancel();
		await f.service.save({ enabled: true, host: "localhost", port: null, password: "a new password 123", securePathEnabled: true });
		const stale = await fetch(`${f.url()}/api/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json", cookie },
			body: JSON.stringify({ method: "appVersion", args: [] }),
		});
		expect(stale.status).toBe(401);
		await f.service.save({ enabled: false, host: "localhost", port: null, securePathEnabled: true });
		const status = f.service.status();
		expect(status.running).toBe(false);
		expect(status.enabled).toBe(false);
	});

	test("a running service can rebind the host and returns fresh URLs", async () => {
		const f = await startWithPassword();
		const before = f.service.status();
		const base = new URL(before.urls[0]).pathname;
		expect(base).toMatch(/^\/[a-z0-9]{6}$/);

		const lan = await f.service.save({
			enabled: true,
			host: "0.0.0.0",
			port: before.configuredPort,
			securePathEnabled: before.securePathEnabled,
		});
		expect(lan.host).toBe("0.0.0.0");
		expect(lan.running).toBe(true);
		expect(lan.urls.length).toBeGreaterThanOrEqual(1);
		expect(lan.urls.some((url) => url.startsWith("http://localhost:"))).toBe(true);
		for (const url of lan.urls) {
			expect(new URL(url).pathname).toBe(base);
		}
		const lanIps = new Set(
			Object.values(networkInterfaces())
				.flatMap((entries) => entries ?? [])
				.filter((n) => n.family === "IPv4" && !n.internal)
				.map((n) => n.address),
		);
		for (const ip of lanIps) {
			expect(lan.urls).toContain(`http://${ip}:${lan.port}${base}`);
		}

		const local = await f.service.save({
			enabled: true,
			host: "localhost",
			port: lan.configuredPort,
			securePathEnabled: lan.securePathEnabled,
		});
		expect(local.host).toBe("localhost");
		expect(local.running).toBe(true);
		expect(local.urls).toEqual([`http://localhost:${local.port}${base}`]);
	});
});

describe("WebUiService secure access path", () => {
	test("unprefixed requests 404; only the secret prefix reaches the app", async () => {
		const f = await startWithPassword();
		const origin = new URL(f.url()).origin;
		const base = new URL(f.url()).pathname;
		expect(base).toMatch(/^\/[a-z0-9]{6}$/);
		for (const path of ["/", "/login"]) {
			const response = await fetch(`${origin}${path}`, { redirect: "manual" });
			expect(response.status).toBe(404);
		}
		const rootLogin = await fetch(`${origin}/api/login`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `password=${encodeURIComponent(PASSWORD)}`,
			redirect: "manual",
		});
		expect(rootLogin.status).toBe(404);
		const opaqueRootLogin = await fetch(`${origin}/api/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "null",
				"Sec-Fetch-Site": "same-origin",
			},
			body: `password=${encodeURIComponent(PASSWORD)}`,
			redirect: "manual",
		});
		expect(opaqueRootLogin.status).toBe(404);
		const evilOriginWrongPrefix = await fetch(`${origin}/zzzzzz`, {
			headers: { Origin: "http://evil.example" },
			redirect: "manual",
		});
		expect(evilOriginWrongPrefix.status).toBe(404);
		const wrongPrefix = await fetch(`${origin}/zzzzzz`, { redirect: "manual" });
		expect(wrongPrefix.status).toBe(404);
		const prefixLike = await fetch(`${origin}${base}evil`, { redirect: "manual" });
		expect(prefixLike.status).toBe(404);

		const root = await fetch(f.url(), { redirect: "manual" });
		expect(root.status).toBe(303);
		expect(root.headers.get("location")).toBe(`${base}/login`);
		const page = await fetch(`${f.url()}/login`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("访问密码");
		const good = await login(f.url());
		expect(good.status).toBe(303);
		expect(good.headers.get("set-cookie") ?? "").toContain("nekocode_webui=");
	});

	test("the prefix protects the API, not only the login page", async () => {
		const f = await startWithPassword();
		const origin = new URL(f.url()).origin;
		const cookie = f.cookieOf(await login(f.url()));
		const unprefixed = await fetch(`${origin}/api/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json", cookie },
			body: JSON.stringify({ method: "appVersion", args: [] }),
		});
		expect(unprefixed.status).toBe(404);
		const prefixed = await fetch(`${f.url()}/api/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json", cookie },
			body: JSON.stringify({ method: "appVersion", args: [] }),
		});
		expect(prefixed.status).toBe(200);
		expect((await prefixed.json()).ok).toBe(true);
	});

	test("toggling the secure path restores root URLs and re-enabling rotates it", async () => {
		const f = await startWithPassword();
		const oldBase = new URL(f.url()).pathname;
		const oldCookie = f.cookieOf(await login(f.url()));

		await f.service.save({ enabled: true, host: "localhost", port: null, securePathEnabled: false });
		const flat = f.url();
		expect(new URL(flat).pathname).toBe("/");
		const root = await fetch(flat, { redirect: "manual" });
		expect(root.status).toBe(303);
		expect(root.headers.get("location")).toBe("/login");
		const good = await login(flat);
		expect(good.status).toBe(303);
		expect(good.headers.get("location")).toBe("/");

		await f.service.save({ enabled: true, host: "localhost", port: null, securePathEnabled: true });
		const newBase = new URL(f.url()).pathname;
		expect(newBase).toMatch(/^\/[a-z0-9]{6}$/);
		expect(newBase).not.toBe(oldBase);
		const stalePrefix = await fetch(`${new URL(f.url()).origin}${oldBase}/login`);
		expect(stalePrefix.status).toBe(404);
		const staleSession = await fetch(`${f.url()}/api/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json", cookie: oldCookie },
			body: JSON.stringify({ method: "appVersion", args: [] }),
		});
		expect(staleSession.status).toBe(401);
	});
});
