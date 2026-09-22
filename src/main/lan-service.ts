import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, join } from "node:path";
import type { SessionSummary } from "../shared/agent";
import type { LanDevice, LanProject, LanStatus } from "../shared/lan";
import type { LanTaskOptions } from "../shared/lan";
import type { RelayRequest, RelayResponse } from "../shared/relay";
import type { AgentService } from "./agent-service";
import { isWorkMode } from "../shared/workflow";
import { isFusionConfig } from "../shared/fusion";
import type { TaskManager } from "./task-manager";

type Device = LanDevice & { tokenHash: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Explicitly enabled LAN gateway. No Electron IPC or arbitrary filesystem API is exposed. */
export class LanService {
	private server: Server | null = null;
	private devices: Device[] = [];
	private projects: LanProject[] = [];
	private pairing: LanStatus["pairing"] = null;
	private urls: string[] = [];
	private origins = new Set<string>();
	private pairAttempts: number[] = [];
	private submissions = new Map<string, { digest: string; result: Promise<unknown> }>();
	private starting: Promise<LanStatus> | null = null;
	private readonly file: string;

	constructor(userData: string, private tasks: TaskManager) {
		mkdirSync(userData, { recursive: true });
		this.file = join(userData, "lan-devices.json");
		try {
			const saved = JSON.parse(readFileSync(this.file, "utf8"));
			this.devices = (saved.devices ?? []).filter((d: Device) => typeof d.id === "string" && typeof d.name === "string" && /^[a-f0-9]{64}$/.test(d.tokenHash));
			this.projects = (saved.projects ?? []).filter((p: LanProject) => typeof p.id === "string" && typeof p.path === "string");
		} catch { /* First launch; binding is disabled on every app launch. */ }
	}

	status(): LanStatus {
		return {
			enabled: !!this.server?.listening, urls: [...this.urls],
			pairing: this.pairing && this.pairing.expiresAt > Date.now() ? { ...this.pairing } : null,
			devices: this.devices.map(({ tokenHash: _, ...device }) => device),
			projects: this.projects.map((p) => ({ ...p })),
		};
	}

	start(port = 47832): Promise<LanStatus> {
		if (this.starting) return this.starting;
		if (this.server?.listening) return Promise.resolve(this.status());
		this.starting = this.listen(port).finally(() => { this.starting = null; });
		return this.starting;
	}

	private async listen(port: number): Promise<LanStatus> {
		const server = createServer((req, res) => { void this.handle(req, res); });
		server.requestTimeout = 15_000;
		server.headersTimeout = 10_000;
		server.maxConnections = 64;
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, "0.0.0.0", () => { server.off("error", reject); resolve(); });
			});
		} catch (error) { this.server = null; throw error; }
		server.on("error", (error) => console.error("LAN server:", error));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("LAN address unavailable");
		const ips = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
			.filter((n) => n.family === "IPv4" && !n.internal).map((n) => n.address);
		this.urls = [...new Set(ips)].map((ip) => `http://${ip}:${address.port}`);
		this.origins = new Set([...this.urls, `http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`]);
		this.newPairing();
		return this.status();
	}

	async stop(): Promise<LanStatus> {
		if (this.starting) await this.starting.catch(() => undefined);
		const server = this.server;
		this.server = null;
		this.urls = [];
		this.origins.clear();
		this.pairing = null;
		if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
		return this.status();
	}

	newPairing(): LanStatus {
		if (!this.server?.listening) throw new Error("请先开启局域网连接");
		this.pairing = { code: randomBytes(5).toString("hex").toUpperCase(), expiresAt: Date.now() + 5 * 60_000 };
		return this.status();
	}

	revoke(id: string): LanStatus {
		this.devices = this.devices.filter((d) => d.id !== id);
		this.save();
		return this.status();
	}

	addProject(path: string): LanStatus {
		const canonical = realpathSync(path);
		if (!statSync(canonical).isDirectory()) throw new Error("请选择项目文件夹");
		if (!this.projects.some((p) => p.path === canonical)) this.projects.push({ id: randomUUID(), name: basename(canonical), path: canonical });
		this.save();
		return this.status();
	}

	removeProject(id: string): LanStatus {
		this.projects = this.projects.filter((p) => p.id !== id);
		this.save();
		return this.status();
	}

	private save(): void {
		const temp = this.file + ".tmp";
		writeFileSync(temp, JSON.stringify({ devices: this.devices, projects: this.projects }), { mode: 0o600 });
		renameSync(temp, this.file);
	}

	private json(res: ServerResponse, status: number, value: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(value));
	}

	private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
		if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415, "Expected JSON");
		let size = 0;
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			size += chunk.length;
			if (size > 64 * 1024) throw new HttpError(413, "请求过大");
			chunks.push(Buffer.from(chunk));
		}
		try {
			const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
			return value;
		} catch { throw new HttpError(400, "Invalid JSON"); }
	}

	private authenticate(req: IncomingMessage): Device {
		const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
		if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, "请先绑定电脑");
		const digest = Buffer.from(hash(token), "hex");
		const device = this.devices.find((d) => timingSafeEqual(Buffer.from(d.tokenHash, "hex"), digest));
		if (!device) throw new HttpError(401, "绑定已失效，请重新配对");
		return device;
	}

	private options(value: unknown): LanTaskOptions {
		if (value === undefined) return {};
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Invalid task options");
		const opts = value as LanTaskOptions;
		if (opts.modelKey !== undefined && (typeof opts.modelKey !== "string" || opts.modelKey.length > 1000)) throw new HttpError(400, "Invalid model");
		if (opts.mode !== undefined && !["read-only", "auto", "full-access"].includes(opts.mode)) throw new HttpError(400, "Invalid permission mode");
		if (opts.workMode !== undefined && !isWorkMode(opts.workMode)) throw new HttpError(400, "Invalid work mode");
		if (opts.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(opts.thinkingLevel)) throw new HttpError(400, "Invalid thinking level");
		if (opts.fusion !== undefined && !isFusionConfig(opts.fusion)) throw new HttpError(400, "Invalid Fusion configuration");
		return opts;
	}

	private async configure(agent: AgentService, options: LanTaskOptions): Promise<void> {
		if (options.mode) agent.setMode(options.mode);
		if (options.workMode) agent.setWorkMode(options.workMode);
		if (options.modelKey) await agent.setModel(options.modelKey);
		if (options.fusion) await agent.setFusion(options.fusion);
		if (options.thinkingLevel) await agent.setThinkingLevel(options.thinkingLevel);
	}

	private once(principal: { id: string }, scope: string, body: Record<string, unknown>, action: () => Promise<unknown>): Promise<unknown> {
		if (typeof body.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw new HttpError(400, "Invalid request ID");
		const key = `${principal.id}:${scope}:${body.requestId}`;
		const digest = hash(JSON.stringify(body));
		const previous = this.submissions.get(key);
		if (previous) {
			if (previous.digest !== digest) throw new HttpError(409, "请求编号已用于其他任务");
			return previous.result;
		}
		if (this.submissions.size >= 2000) throw new HttpError(429, "本次连接的请求数已达上限，请重启应用");
		const result = action();
		this.submissions.set(key, { digest, result });
		return result;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
		try {
			const origin = `http://${req.headers.host}`;
			if (!this.origins.has(origin) || (req.headers.origin && req.headers.origin !== origin)) throw new HttpError(403, "Origin not allowed");
			const path = new URL(req.url ?? "/", origin).pathname;
			if (req.method === "GET" && path === "/api/info") {
				this.json(res, 200, { name: "NekoCode Desktop", protocol: 1 }); return;
			}
			if (req.method === "POST" && path === "/api/pair") {
				this.pairAttempts = this.pairAttempts.filter((at) => at > Date.now() - 60_000);
				if (this.pairAttempts.length >= 10) throw new HttpError(429, "尝试过于频繁，请一分钟后重试");
				this.pairAttempts.push(Date.now());
				const body = await this.body(req);
				const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
				const pairing = this.status().pairing;
				if (!pairing || !/^[A-F0-9]{10}$/.test(code) || !timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code))) throw new HttpError(403, "配对码错误或已过期");
				if (this.devices.length >= 20) throw new HttpError(409, "绑定设备已达上限，请在电脑端移除旧设备");
				const token = randomBytes(32).toString("hex");
				this.devices.push({ id: randomUUID(), name: typeof body.name === "string" ? body.name.trim().slice(0, 60) || "手机" : "手机", pairedAt: Date.now(), tokenHash: hash(token) });
				this.save(); this.pairing = null;
				this.json(res, 200, { token }); return;
			}
			const device = this.authenticate(req);
			const payload = req.method === "POST" ? await this.body(req) : undefined;
			this.json(res, 200, await this.dispatch(device, req.method ?? "", path, payload)); return;
		} catch (error) {
			if (!res.headersSent && !res.destroyed) this.json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : "Request failed" });
		}
	}

	/** The session file is a path on this machine; remote clients never see it. */
	private withoutSessionFile<T extends { session: SessionSummary }>(value: T) {
		return { ...value, session: { ...value.session, sessionFile: undefined } };
	}

	private async dispatch(
		principal: { id: string },
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<unknown> {
		const defaults = /^\/api\/projects\/([a-zA-Z0-9-]+)\/defaults$/.exec(path);
		if (method === "GET" && defaults) {
			const project = this.projects.find((p) => p.id === defaults[1]);
			if (!project) throw new HttpError(403, "请先在电脑端授权此项目");
			return this.tasks.defaults(project.path);
		}
		if (method === "GET" && path === "/api/state") {
			const tasks = (await this.tasks.list()).map(({ sessionFile: _, ...task }) => task);
			return { tasks, projects: this.projects.map(({ id, name, path }) => ({ id, name, path })) };
		}
		if (method === "POST" && path === "/api/tasks") {
			const input = body!;
			if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 32_000 || input.text.trim().startsWith("/")) throw new HttpError(400, "请输入任务描述（不支持以 / 开头的命令）");
			const project = this.projects.find((p) => p.id === input.projectId);
			if (!project) throw new HttpError(403, "请先在电脑端授权此项目");
			const options = this.options(input.options);
			const text = input.text.trim();
			return this.once(principal, "create", input, async () => {
				const agent = await this.tasks.create(project.path, false);
				const id = agent.getSnapshot()!.session.id;
				try { await this.configure(agent, options); return { id, ...await agent.send({ text }) }; }
				catch (error) { return { id, accepted: false, error: error instanceof Error ? error.message : String(error) }; }
			});
		}
		const match = /^\/api\/tasks\/([a-zA-Z0-9-]+)(?:\/(abort|answer|send|configure|commands|cancel-worker|delta|tool-output))?$/.exec(path);
		if (match && ((method === "GET" && (!match[2] || match[2] === "commands")) || (method === "POST" && match[2] && match[2] !== "commands"))) {
			const agent = await this.tasks.byId(match[1]);
			if (match[2] === "commands") return (await agent.slashCommands()).filter((c) => c.name !== "terminal");
			if (match[2] === "tool-output") {
				const input = body!;
				if (typeof input.toolCallId !== "string" || !input.toolCallId || input.toolCallId.length > 200) {
					throw new HttpError(400, "Invalid tool call");
				}
				const offset = typeof input.offset === "number" && Number.isInteger(input.offset) ? input.offset : 0;
				const chunk = agent.toolOutput(input.toolCallId, offset);
				if (!chunk) throw new HttpError(404, "该工具输出已不在当前会话中");
				return chunk;
			}
			if (match[2] === "delta") {
				const input = body!;
				const since = typeof input.since === "string" && input.since.length <= 64 ? input.since : undefined;
				// Cell ids are the transcript's own, so a long or odd one is simply not
				// found and the window falls back to the tail.
				const from = typeof input.from === "string" && input.from.length <= 200 ? input.from : undefined;
				const back = typeof input.back === "number" && Number.isInteger(input.back) ? input.back : undefined;
				const delta = agent.snapshotDelta({ since, from, back });
				if (!delta) return null;
				return {
					...delta,
					...(delta.full ? { full: this.withoutSessionFile(delta.full) } : {}),
					...(delta.rest ? { rest: this.withoutSessionFile(delta.rest) } : {}),
				};
			}
			if (match[2] === "configure") await this.configure(agent, this.options(body));
			if (match[2] === "cancel-worker") {
				if (typeof body!.id !== "string") throw new HttpError(400, "Invalid worker ID");
				agent.cancelTask(body!.id);
			}
			if (match[2] === "send") {
				const input = body!;
				if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 32_000 || /^\/terminal(?:\s|$)/.test(input.text.trim())) throw new HttpError(400, "请输入有效消息");
				const text = input.text;
				return this.once(principal, `send:${match[1]}`, input, () => agent.send({ text }));
			}
			if (match[2] === "abort") await agent.abort();
			if (match[2] === "answer") {
				const input = body!;
				const pending = agent.getSnapshot()?.workflow.request;
				if (!pending || input.requestId !== pending.id || typeof input.answers !== "object" || !input.answers || Array.isArray(input.answers)) throw new HttpError(409, "问题已变化，请刷新后重试");
				const answers: Record<string, { text?: string; optionId?: string }> = {};
				for (const q of pending.questions) {
					const answer = (input.answers as Record<string, unknown>)[q.id] as { text?: unknown; optionId?: unknown } | undefined;
					if (answer && typeof answer === "object") answers[q.id] = {
						text: typeof answer.text === "string" ? answer.text.slice(0, 8000) : undefined,
						optionId: typeof answer.optionId === "string" && q.options.some((o) => o.id === answer.optionId) ? answer.optionId : undefined,
					};
				}
				agent.answerWorkflow({ requestId: pending.id, answers, cancelled: input.cancelled === true });
			}
			const snapshot = agent.getSnapshot();
			return snapshot ? this.withoutSessionFile(snapshot) : null;
		}
		throw new HttpError(404, "Not found");
	}

	async handleRelay(peerId: string, request: RelayRequest): Promise<RelayResponse> {
		const id = typeof request?.id === "string" ? request.id : "";
		const invalid = (message: string): RelayResponse => ({ id, status: 400, body: { error: message } });
		try {
			if (!/^[A-Za-z0-9_-]{16,128}$/.test(peerId)) return invalid("Invalid peer");
			if (!/^[A-Za-z0-9-]{16,80}$/.test(id)) return invalid("Invalid request ID");
			if (request.method !== "GET" && request.method !== "POST") return invalid("Invalid method");
			const path = request.path;
			if (typeof path !== "string" || !path.startsWith("/api/") || path.length > 1024 || path.includes("?") || path.includes("#")) return invalid("Invalid path");
			if (request.method === "GET" && request.body !== undefined) return invalid("Invalid body");
			if (request.method === "POST" && (typeof request.body !== "object" || request.body === null || Array.isArray(request.body))) return invalid("Invalid body");
			const result = await this.dispatch({ id: `relay:${peerId}` }, request.method, path, request.body);
			return { id, status: 200, body: result };
		} catch (error) {
			if (error instanceof HttpError) return { id, status: error.status, body: { error: error.message } };
			return { id, status: 500, body: { error: "Request failed" } };
		}
	}
}
