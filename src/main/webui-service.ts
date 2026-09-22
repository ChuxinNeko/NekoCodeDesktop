import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ShellInfo } from "../shared/window";
import {
	isWebUiEventChannel,
	isWebUiRpcMethod,
	type SaveWebUiConfigRequest,
	type WebUiEventChannel,
	type WebUiHost,
	type WebUiRpcMethod,
	type WebUiRuntime,
	type WebUiStatus,
} from "../shared/webui";

interface WebUiServiceOptions {
	userDataDir: string;
	rendererDir: string;
	rendererDevUrl?: string;
	homeDir: string;
	shell: ShellInfo;
	invoke(method: WebUiRpcMethod, args: unknown[]): Promise<unknown>;
}

interface WebUiConfig {
	enabled: boolean;
	host: WebUiHost;
	port: number | null;
	securePathEnabled: boolean;
	accessPath: string;
	passwordSalt?: string;
	passwordHash?: string;
}

const ACCESS_PATH_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateAccessPath(): string {
	let value = "";
	for (let i = 0; i < 6; i++) value += ACCESS_PATH_ALPHABET[randomInt(36)];
	return value;
}

const COOKIE_NAME = "nekocode_webui";
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_MAX = 64;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_BODY_MAX = 4 * 1024;
const RPC_BODY_MAX = 2 * 1024 * 1024;
const RPC_ARGS_MAX = 16;
const SSE_KEEPALIVE_MS = 25_000;

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".txt": "text/plain; charset=utf-8",
	".wasm": "application/wasm",
	".mp3": "audio/mpeg",
	".webmanifest": "application/manifest+json",
};

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loginPage(basePath: string, error: string | null): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>NekoCode Desktop</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f9f9f7; color: #1a1a19; }
@media (prefers-color-scheme: dark) { body { background: #1a1a19; color: #f2f2ef; } .card { background: #242423; border-color: #3a3a38; } input { background: #1a1a19; color: #f2f2ef; border-color: #3a3a38; } }
.card { width: 100%; max-width: 340px; margin: 16px; padding: 28px 24px; background: #ffffff; border: 1px solid #e4e4e0; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
h1 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
p.hint { margin: 0 0 18px; font-size: 12px; color: #8a8a85; }
label { display: block; font-size: 12px; margin-bottom: 6px; }
input { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid #d4d4d0; border-radius: 8px; background: #fff; }
input:focus { outline: 2px solid #6b6bf0; outline-offset: -1px; }
button { margin-top: 14px; width: 100%; padding: 8px 10px; font-size: 13px; font-weight: 500; color: #fff; background: #5454e8; border: none; border-radius: 8px; cursor: pointer; }
button:hover { background: #4545d6; }
.error { margin: 12px 0 0; padding: 8px 10px; font-size: 12px; color: #b3261e; background: rgba(179,38,30,.08); border-radius: 8px; }
</style>
</head>
<body>
<form class="card" method="post" action="${basePath}/api/login" autocomplete="off">
<h1>NekoCode Desktop</h1>
<p class="hint">输入访问密码以继续</p>
<label for="password">访问密码</label>
<input id="password" name="password" type="password" required autofocus />
<button type="submit">登录</button>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
</form>
</body>
</html>`;
}

export class WebUiService {
	private server: Server | null = null;
	private port: number | null = null;
	private urls: string[] = [];
	private allowedHosts = new Set<string>();
	private error: string | null = null;
	private config: WebUiConfig;
	private readonly sessions = new Map<string, number>();
	private readonly sseClients = new Set<ServerResponse>();
	private readonly loginAttempts = new Map<string, number[]>();
	private starting: Promise<WebUiStatus> | null = null;

	constructor(private readonly options: WebUiServiceOptions) {
		mkdirSync(options.userDataDir, { recursive: true });
		const { config, migrated } = this.loadConfig();
		this.config = config;
		if (migrated) this.persist();
	}

	private configFile(): string {
		return join(this.options.userDataDir, "webui.json");
	}

	private loadConfig(): { config: WebUiConfig; migrated: boolean } {
		const fallback = (): WebUiConfig => ({
			enabled: false,
			host: "localhost",
			port: null,
			securePathEnabled: true,
			accessPath: generateAccessPath(),
		});
		try {
			const saved: unknown = JSON.parse(readFileSync(this.configFile(), "utf8"));
			if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
				return { config: fallback(), migrated: false };
			}
			const raw = saved as Record<string, unknown>;
			let migrated = false;
			let securePathEnabled = true;
			if (typeof raw.securePathEnabled === "boolean") {
				securePathEnabled = raw.securePathEnabled;
			} else {
				migrated = true;
			}
			let accessPath: string;
			if (typeof raw.accessPath === "string" && /^[a-z0-9]{6}$/.test(raw.accessPath)) {
				accessPath = raw.accessPath;
			} else {
				accessPath = generateAccessPath();
				migrated = true;
			}
			return {
				config: {
					enabled: raw.enabled === true,
					host: raw.host === "0.0.0.0" ? "0.0.0.0" : "localhost",
					port: Number.isInteger(raw.port) && (raw.port as number) >= 1 && (raw.port as number) <= 65535
						? (raw.port as number)
						: null,
					securePathEnabled,
					accessPath,
					passwordSalt: typeof raw.passwordSalt === "string" && /^[a-f0-9]{32}$/.test(raw.passwordSalt) ? raw.passwordSalt : undefined,
					passwordHash: typeof raw.passwordHash === "string" && /^[a-f0-9]{64}$/.test(raw.passwordHash) ? raw.passwordHash : undefined,
				},
				migrated,
			};
		} catch {
			return { config: fallback(), migrated: false };
		}
	}

	private persist(): void {
		const file = this.configFile();
		const temp = `${file}.tmp`;
		writeFileSync(temp, JSON.stringify(this.config), { mode: 0o600 });
		renameSync(temp, file);
	}

	private hasPassword(): boolean {
		return !!this.config.passwordSalt && !!this.config.passwordHash;
	}

	status(): WebUiStatus {
		return {
			enabled: this.config.enabled,
			running: !!this.server?.listening,
			host: this.config.host,
			configuredPort: this.config.port,
			port: this.port,
			urls: [...this.urls],
			hasPassword: this.hasPassword(),
			error: this.error,
			securePathEnabled: this.config.securePathEnabled,
		};
	}

	async save(request: SaveWebUiConfigRequest): Promise<WebUiStatus> {
		if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("无效的 WebUI 配置");
		if (typeof request.enabled !== "boolean") throw new Error("无效的启用状态");
		if (request.host !== "localhost" && request.host !== "0.0.0.0") throw new Error("无效的监听地址");
		const port = request.port;
		if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
			throw new Error("端口必须是 1-65535 的整数，或留空使用随机端口");
		}
		if (request.password !== undefined) {
			if (typeof request.password !== "string" || request.password.length < 8 || request.password.length > 128) {
				throw new Error("密码长度必须为 8-128 个字符");
			}
		}
		if (typeof request.securePathEnabled !== "boolean") throw new Error("无效的安全路径设置");
		const next: WebUiConfig = {
			enabled: request.enabled === true,
			host: request.host,
			port,
			securePathEnabled: request.securePathEnabled,
			accessPath: this.config.accessPath,
			passwordSalt: this.config.passwordSalt,
			passwordHash: this.config.passwordHash,
		};
		if (!this.config.securePathEnabled && next.securePathEnabled) {
			next.accessPath = generateAccessPath();
		}
		if (this.config.securePathEnabled !== next.securePathEnabled) this.sessions.clear();
		if (request.password !== undefined) {
			const salt = randomBytes(16);
			next.passwordSalt = salt.toString("hex");
			next.passwordHash = scryptSync(request.password, salt, 32).toString("hex");
			this.sessions.clear();
		}
		if (next.enabled && (!next.passwordSalt || !next.passwordHash)) {
			throw new Error("开启 WebUI 前必须先设置访问密码");
		}
		this.config = next;
		this.persist();
		if (!next.enabled) return this.stop();
		await this.stopServer();
		return this.listen();
	}

	async startConfigured(): Promise<WebUiStatus> {
		if (!this.config.enabled) return this.status();
		if (!this.hasPassword()) {
			this.error = "WebUI 已启用但未设置密码";
			return this.status();
		}
		if (this.server?.listening) return this.status();
		return this.listen();
	}

	async stop(): Promise<WebUiStatus> {
		await this.stopServer();
		return this.status();
	}

	private async stopServer(): Promise<void> {
		if (this.starting) await this.starting.catch(() => undefined);
		const server = this.server;
		this.server = null;
		this.port = null;
		this.urls = [];
		this.allowedHosts.clear();
		for (const client of this.sseClients) client.destroy();
		this.sseClients.clear();
		if (server) {
			await new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			});
		}
	}

	private basePath(): string {
		return this.config.securePathEnabled ? `/${this.config.accessPath}` : "";
	}

	private async listen(): Promise<WebUiStatus> {
		if (this.starting) return this.starting;
		this.starting = this.doListen().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async doListen(): Promise<WebUiStatus> {
		const server = createServer((req, res) => {
			void this.handle(req, res);
		});
		server.headersTimeout = 10_000;
		server.requestTimeout = 10 * 60_000;
		server.maxConnections = 128;
		this.server = server;
		const bindHost = this.config.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
		try {
			await new Promise<void>((resolveListen, reject) => {
				server.once("error", reject);
				server.listen(this.config.port ?? 0, bindHost, () => {
					server.off("error", reject);
					resolveListen();
				});
			});
		} catch (error) {
			this.server = null;
			this.port = null;
			this.urls = [];
			this.allowedHosts.clear();
			this.error = error instanceof Error ? error.message : String(error);
			return this.status();
		}
		server.on("error", (error) => console.error("WebUI server:", error));
		const address = server.address();
		if (!address || typeof address === "string") {
			this.error = "WebUI listen address unavailable";
			return this.status();
		}
		this.port = address.port;
		this.error = null;
		const base = this.basePath();
		const urls = [`http://localhost:${this.port}${base}`];
		const hosts = new Set<string>([`localhost:${this.port}`, `127.0.0.1:${this.port}`]);
		if (this.config.host === "0.0.0.0") {
			const ips = Object.values(networkInterfaces())
				.flatMap((entries) => entries ?? [])
				.filter((n) => n.family === "IPv4" && !n.internal)
				.map((n) => n.address);
			for (const ip of new Set(ips)) {
				urls.push(`http://${ip}:${this.port}${base}`);
				hosts.add(`${ip}:${this.port}`);
			}
		}
		this.urls = urls;
		this.allowedHosts = hosts;
		return this.status();
	}

	broadcast(channel: WebUiEventChannel, payload: unknown): void {
		if (!isWebUiEventChannel(channel) || this.sseClients.size === 0) return;
		let frame: string;
		try {
			frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
		} catch {
			return;
		}
		for (const client of this.sseClients) {
			if (client.destroyed) {
				this.sseClients.delete(client);
				continue;
			}
			client.write(frame);
		}
	}

	private securityHeaders(res: ServerResponse): void {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Frame-Options", "DENY");
		const scriptSrc = this.options.rendererDevUrl ? "'self' 'unsafe-inline'" : "'self'";
		res.setHeader(
			"Content-Security-Policy",
			`default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
		);
	}

	private json(res: ServerResponse, status: number, value: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(value));
	}

	private redirect(res: ServerResponse, location: string, extraHeaders: Record<string, string> = {}): void {
		res.writeHead(303, { Location: location, ...extraHeaders });
		res.end();
	}

	private async readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
		let size = 0;
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > maxBytes) throw new HttpError(413, "请求过大");
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}

	private sessionFrom(req: IncomingMessage): string | null {
		const header = req.headers.cookie;
		if (!header) return null;
		for (const part of header.split(";")) {
			const eq = part.indexOf("=");
			if (eq === -1) continue;
			if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
			const token = part.slice(eq + 1).trim();
			const seen = this.sessions.get(token);
			if (seen === undefined) return null;
			if (Date.now() - seen > SESSION_IDLE_MS) {
				this.sessions.delete(token);
				return null;
			}
			this.sessions.set(token, Date.now());
			return token;
		}
		return null;
	}

	private createSession(): string {
		while (this.sessions.size >= SESSION_MAX) {
			let oldest: string | null = null;
			let oldestAt = Infinity;
			for (const [token, at] of this.sessions) {
				if (at < oldestAt) {
					oldest = token;
					oldestAt = at;
				}
			}
			if (oldest === null) break;
			this.sessions.delete(oldest);
		}
		const token = randomBytes(32).toString("base64url");
		this.sessions.set(token, Date.now());
		return token;
	}

	private verifyPassword(password: string): boolean {
		const { passwordSalt, passwordHash } = this.config;
		if (!passwordSalt || !passwordHash) return false;
		const derived = scryptSync(password, Buffer.from(passwordSalt, "hex"), 32);
		return timingSafeEqual(derived, Buffer.from(passwordHash, "hex"));
	}

	private loginLimited(ip: string): boolean {
		const now = Date.now();
		const attempts = (this.loginAttempts.get(ip) ?? []).filter((at) => at > now - LOGIN_WINDOW_MS);
		this.loginAttempts.set(ip, attempts);
		return attempts.length >= LOGIN_LIMIT;
	}

	private recordLoginFailure(ip: string): void {
		this.loginAttempts.get(ip)?.push(Date.now());
	}

	private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers["content-type"]?.split(";")[0].trim() !== "application/x-www-form-urlencoded") {
			throw new HttpError(415, "无效的登录请求");
		}
		const ip = req.socket.remoteAddress ?? "";
		if (this.loginLimited(ip)) throw new HttpError(429, "尝试过于频繁，请稍后再试");
		const body = await this.readBody(req, LOGIN_BODY_MAX);
		const params = new URLSearchParams(body.toString("utf8"));
		const password = params.get("password") ?? "";
		if (!this.verifyPassword(password)) {
			this.recordLoginFailure(ip);
			res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
			res.end(loginPage(this.basePath(), "密码错误，请重试"));
			return;
		}
		this.loginAttempts.delete(ip);
		const token = this.createSession();
		this.redirect(res, `${this.basePath()}/`, {
			"Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
		});
	}

	private handleEvents(req: IncomingMessage, res: ServerResponse): void {
		req.socket.setTimeout(0);
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
		});
		res.write(": connected\n\n");
		const keepalive = setInterval(() => {
			if (!res.destroyed) res.write(": keepalive\n\n");
		}, SSE_KEEPALIVE_MS);
		this.sseClients.add(res);
		res.on("close", () => {
			clearInterval(keepalive);
			this.sseClients.delete(res);
		});
	}

	private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
			throw new HttpError(415, "Expected JSON");
		}
		const body = await this.readBody(req, RPC_BODY_MAX);
		let parsed: unknown;
		try {
			parsed = JSON.parse(body.toString("utf8"));
		} catch {
			throw new HttpError(400, "Invalid JSON");
		}
		const request = parsed as { method?: unknown; args?: unknown };
		if (!request || typeof request !== "object" || !isWebUiRpcMethod(request.method)) {
			throw new HttpError(403, "该方法不允许通过 WebUI 调用");
		}
		if (!Array.isArray(request.args) || request.args.length > RPC_ARGS_MAX) {
			throw new HttpError(400, "无效的调用参数");
		}
		try {
			const result = await this.options.invoke(request.method, request.args);
			this.json(res, 200, { ok: true, result });
		} catch (error) {
			this.json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private runtimeScript(res: ServerResponse): void {
		const runtime: WebUiRuntime = {
			runtime: "web",
			homeDir: this.options.homeDir,
			shell: this.options.shell,
			basePath: this.basePath(),
		};
		const json = JSON.stringify(runtime).replace(/</g, "\\u003c");
		res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
		res.end(`window.__NEKOCODE_WEBUI__ = Object.freeze(${json});\n`);
	}

	private injectRuntime(html: string): string {
		const marked = html.replace('data-runtime="electron"', 'data-runtime="web"');
		const tag = `<script src="${this.basePath()}/webui-runtime.js"></script>`;
		const at = marked.search(/<script[\s>]/i);
		return at === -1 ? marked : `${marked.slice(0, at)}${tag}${marked.slice(at)}`;
	}

	private async serveStatic(path: string, res: ServerResponse): Promise<void> {
		const root = resolve(this.options.rendererDir);
		const rel = normalize(path === "/" ? "/index.html" : path);
		const target = resolve(join(root, rel));
		if (target !== root && !target.startsWith(root + sep)) throw new HttpError(403, "Forbidden");
		const info = await stat(target).catch(() => null);
		if (!info || !info.isFile()) throw new HttpError(404, "Not found");
		if (target.endsWith(`${sep}index.html`) || target === join(root, "index.html")) {
			const html = await readFile(target, "utf8");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(this.injectRuntime(html));
			return;
		}
		const body = await readFile(target);
		res.writeHead(200, { "Content-Type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream" });
		res.end(body);
	}

	private async proxyDev(req: IncomingMessage, res: ServerResponse, pathname: string, search: string): Promise<void> {
		const base = this.options.rendererDevUrl;
		if (!base) throw new HttpError(404, "Not found");
		const target = new URL(`${pathname}${search}`, base);
		const upstream = await fetch(target, {
			method: req.method === "HEAD" ? "HEAD" : "GET",
			headers: { accept: req.headers.accept ?? "*/*" },
			signal: AbortSignal.timeout(15_000),
		});
		const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
		const buffer = Buffer.from(await upstream.arrayBuffer());
		res.writeHead(upstream.status, { "Content-Type": contentType });
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		if (pathname === "/" && contentType.includes("text/html")) {
			res.end(this.injectRuntime(buffer.toString("utf8")));
			return;
		}
		res.end(buffer);
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		this.securityHeaders(res);
		let routePath = "";
		try {
			const host = (req.headers.host ?? "").toLowerCase();
			if (!this.allowedHosts.has(host)) throw new HttpError(403, "Forbidden");
			const parsed = new URL(req.url ?? "/", `http://${host}`);
			const pathname = parsed.pathname;
			const base = this.basePath();
			let prefixed = false;
			routePath = pathname;
			if (base === "") {
				prefixed = true;
			} else if (pathname === base) {
				prefixed = true;
				routePath = "/";
			} else if (pathname.startsWith(`${base}/`)) {
				prefixed = true;
				routePath = pathname.slice(base.length) || "/";
			}
			let fallbackSession: string | null = null;
			if (!prefixed) {
				fallbackSession = this.sessionFrom(req);
				if (!fallbackSession) throw new HttpError(404, "Not found");
			}
			const loginRequest = prefixed && req.method === "POST" && routePath === "/api/login";
			if (loginRequest) {
				if (req.headers["sec-fetch-site"] === "cross-site") {
					throw new HttpError(403, "Origin not allowed");
				}
			} else if (req.headers.origin && req.headers.origin !== `http://${host}`) {
				throw new HttpError(403, "Origin not allowed");
			}
			if (!prefixed) {
				const staticFallback =
					(req.method === "GET" || req.method === "HEAD") &&
					!pathname.startsWith("/api/") &&
					pathname !== "/login" &&
					pathname !== "/webui-runtime.js";
				if (staticFallback) {
					if (this.options.rendererDevUrl) {
						await this.proxyDev(req, res, pathname, parsed.search);
					} else {
						await this.serveStatic(pathname, res);
					}
					return;
				}
				throw new HttpError(404, "Not found");
			}
			if (req.method === "GET" && routePath === "/login") {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(loginPage(base, null));
				return;
			}
			if (req.method === "POST" && routePath === "/api/login") {
				await this.handleLogin(req, res);
				return;
			}
			const session = this.sessionFrom(req);
			if (!session) {
				if (req.method === "GET" && !routePath.startsWith("/api/")) {
					this.redirect(res, `${base}/login`);
				} else {
					this.json(res, 401, { error: "未登录" });
				}
				return;
			}
			if (req.method === "POST" && routePath === "/api/logout") {
				this.sessions.delete(session);
				this.redirect(res, `${base}/login`, {
					"Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
				});
				return;
			}
			if (req.method === "GET" && routePath === "/api/events") {
				this.handleEvents(req, res);
				return;
			}
			if (req.method === "POST" && routePath === "/api/rpc") {
				await this.handleRpc(req, res);
				return;
			}
			if (req.method === "GET" && routePath === "/webui-runtime.js") {
				this.runtimeScript(res);
				return;
			}
			if (req.method === "GET" || req.method === "HEAD") {
				if (this.options.rendererDevUrl) {
					await this.proxyDev(req, res, routePath, parsed.search);
				} else {
					await this.serveStatic(routePath, res);
				}
				return;
			}
			throw new HttpError(404, "Not found");
		} catch (error) {
			if (res.headersSent || res.destroyed) return;
			const status = error instanceof HttpError ? error.status : 500;
			const wantsHtml = req.method === "GET" && !routePath.startsWith("/api/");
			if (wantsHtml) {
				res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(error instanceof Error ? error.message : "Request failed");
			} else {
				this.json(res, status, { error: error instanceof Error ? error.message : "Request failed" });
			}
		}
	}
}
