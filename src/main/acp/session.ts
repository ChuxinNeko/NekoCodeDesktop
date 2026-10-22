/**
 * One conversation with an external ACP agent: its process, its handshake,
 * and the transcript it streams back.
 *
 * Lifecycle: `start()` spawns the agent and runs initialize → session/new;
 * `prompt()` runs one turn; `dispose()` kills the process tree. A process that
 * dies on its own leaves the session in `error` with the agent's last stderr.
 */
import type { PromptImageAttachment, TurnUsage } from "../../shared/agent";
import type {
	AcpPermissionOptionKind,
	AcpPermissionRequest,
	AcpSessionSnapshot,
	AcpSessionStatus,
	AcpSessionSummary,
} from "../../shared/acp";
import type { AcpAgentDefinition } from "./agents";
import { authenticateAgent } from "./auth";
import { AcpConnection, AcpRpcError, AUTH_REQUIRED, METHOD_NOT_FOUND, type AcpTransport } from "./connection";
import { AcpProjection, diffPaths, MODE_CONFIG_ID, MODEL_CONFIG_ID, turnUsageFromAcp, type RawToolCall, type TextDiffer } from "./projection";
import type { ShellChangeTracker } from "./workspace-changes";
import { recordDiagnostic, diagnosticError } from "../diagnostic-log";
import { DEFAULT_APP_PREFERENCES, isAutoRetryCount } from "../../shared/preferences";
import { acpUsageModel } from "./model-settings";

export const ACP_PROTOCOL_VERSION = 1;

/** The first launch may have `npx` download the adapter, which is slow. */
const STARTUP_TIMEOUT_MS = 180_000;

/** An MCP server as ACP describes it in `session/new`. */
export interface AcpMcpServer {
	type: "http";
	name: string;
	url: string;
	headers: Array<{ name: string; value: string }>;
}

/** NekoCode's tools for one session, and how to take them away again. */
export interface AcpToolServers {
	servers: AcpMcpServer[];
	dispose(): void;
}

export interface AcpSessionOptions {
	/** Read per turn so an existing conversation uses newly saved settings. */
	autoRetryCount?: () => number;
	/** Backoff base; injectable so protocol tests need not wait seconds. */
	retryDelayMs?: number;
	id: string;
	agent: AcpAgentDefinition;
	cwd: string;
	clientVersion: string;
	createTransport: (agent: AcpAgentDefinition, cwd: string) => AcpTransport;
	onChange: () => void;
	/** Usage from a new prompt response, independent of whether it produced a text cell. */
	onUsage?: (usage: TurnUsage, timestamp: number) => void;
	/** Reopen a conversation from the agent's own history instead of starting one. */
	resume?: { sessionId: string; title?: string };
	/**
	 * Where the agent process runs, when that cannot be the conversation's own
	 * directory — a history entry whose project has since been deleted.
	 */
	processCwd?: string;
	/** NekoCode's own tools, attached to the session as MCP servers. */
	toolServers?: () => Promise<AcpToolServers>;
	/** Line diffs for the edit cards. */
	textDiffer?: () => Promise<TextDiffer>;
	/** What the agent's shell commands change in the project, for cards of their own. */
	shellChanges?: () => Promise<ShellChangeTracker | null>;
	/** The environment the agent runs with, for choosing how it signs in. */
	env?: Record<string, string | undefined>;
	now?: () => number;
}

interface PendingPermission {
	request: AcpPermissionRequest;
	resolve: (outcome: unknown) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const PERMISSION_KINDS = new Set<AcpPermissionOptionKind>(["allow_once", "allow_always", "reject_once", "reject_always"]);

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function userText(text: string, images: PromptImageAttachment[]): string {
	if (images.length === 0) return text;
	return `${text}${text ? "\n\n" : ""}${images.map((image) => `[图片 ${image.name}]`).join(" ")}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function retryableToolProtocolError(error: unknown): boolean {
	const message = errorText(error);
	return /\bbasispoints_tool_arguments_stalled\b/.test(message) ||
		(/\bbasispoints_protocol_error\b/.test(message) && /no tool was executed/i.test(message));
}

const RETRY_CONTINUATION = "The previous attempt was interrupted by a tool-call protocol error. Continue the current task from where it stopped, correcting the failed tool call arguments. Check existing results first and do not repeat operations that already succeeded.";

/** The files an edit tool call is about: its diffs, or where it says it acts. */
function editedPaths(raw: Readonly<RawToolCall>): string[] {
	const fromDiffs = diffPaths(raw);
	if (fromDiffs.length > 0) return fromDiffs;
	return (Array.isArray(raw.locations) ? raw.locations : []).flatMap((location: unknown) =>
		isObject(location) && typeof location.path === "string" ? [location.path] : [],
	);
}

export class AcpSession {
	readonly id: string;
	readonly agent: AcpAgentDefinition;
	readonly cwd: string;
	readonly createdAt: number;
	private updatedAt: number;
	private status: AcpSessionStatus = "starting";
	private error: string | undefined;
	private connection: AcpConnection | null = null;
	private agentSessionId: string | null = null;
	private supportsImages = false;
	private authMethods: string[] = [];
	private disposed = false;
	private readonly projection: AcpProjection;
	private readonly permissions = new Map<string, PendingPermission>();
	private promptPending = false;
	private promptDispatched = false;
	private queuedPromptCancelled = false;
	private cancelRetryWait: (() => void) | null = null;
	private modelMs: number | undefined;
	/** Claude's SDK reports a session-wide counter, restored when resuming. */
	private lastApiDurationMs: number | undefined;
	private attemptApiDurationStart: number | undefined;
	private configTail: Promise<void> = Promise.resolve();
	private pendingConfig: Promise<void> | null = null;
	private nextPermission = 1;
	private readonly now: () => number;
	/** Settles once the handshake is over, however it went. */
	private started: Promise<void> = Promise.resolve();
	private tools: AcpToolServers | null = null;
	/** A message has been sent; the session is a conversation now. */
	private prompted = false;
	private mcpServers: AcpMcpServer[] = [];
	private shell: ShellChangeTracker | null = null;
	private shellOpening: Promise<void> = Promise.resolve();
	/** Commands whose changes have been looked for already. */
	private readonly settledCommands = new Set<string>();

	constructor(private readonly options: AcpSessionOptions) {
		this.id = options.id;
		this.agent = options.agent;
		this.cwd = options.cwd;
		this.now = options.now ?? Date.now;
		this.lastApiDurationMs = options.resume ? undefined : 0;
		this.createdAt = this.now();
		this.updatedAt = this.createdAt;
		this.projection = new AcpProjection(this.now, (model) => acpUsageModel(this.agent, model));
	}

	private changed(): void {
		this.updatedAt = this.now();
		this.options.onChange();
	}

	summary(): AcpSessionSummary {
		// A resumed conversation is known by its id from the start, not once the
		// load returns: opening it again meanwhile must find this one, and the
		// sidebar row and split pane that show it must not change key under it.
		const agentSessionId = this.agentSessionId ?? this.options.resume?.sessionId;
		return {
			id: this.id,
			...(agentSessionId ? { agentSessionId } : {}),
			agentId: this.agent.id,
			agentName: this.agent.name,
			cwd: this.cwd,
			title: this.projection.title || this.options.resume?.title || this.firstPrompt() || this.agent.name,
			status: this.status,
			pristine: !this.options.resume && !this.prompted,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
		};
	}

	private firstPrompt(): string {
		const first = this.projection.cells.find((cell) => cell.type === "user");
		return first?.type === "user" ? first.text.split("\n", 1)[0].slice(0, 80) : "";
	}

	snapshot(): AcpSessionSnapshot {
		return {
			...this.summary(),
			...(this.error ? { error: this.error } : {}),
			cells: this.projection.cells,
			streaming: this.status === "prompting",
			...(this.projection.context ? { context: this.projection.context } : {}),
			configOptions: this.projection.configOptions(),
			commands: this.projection.commands,
			permissions: [...this.permissions.values()].map((pending) => pending.request),
			supportsImages: this.supportsImages,
		};
	}

	start(): Promise<void> {
		this.started = this.run();
		return this.started;
	}

	private async run(): Promise<void> {
		let transport: AcpTransport;
		try {
			transport = this.options.createTransport(this.agent, this.options.processCwd ?? this.cwd);
		} catch (error) {
			if (!this.disposed) this.fail(errorText(error));
			return;
		}
		const connection = new AcpConnection(transport);
		this.connection = connection;
		this.shellOpening = (this.options.shellChanges?.() ?? Promise.resolve(null)).then(
			(tracker) => {
				if (this.disposed) tracker?.dispose();
				else this.shell = tracker;
			},
			() => undefined,
		);
		// Before any update arrives: a loaded session's replay carries edits too.
		const differ = this.options.textDiffer?.().then(
			(diff) => this.projection.setDiffer(diff),
			() => undefined,
		);
		connection.onNotification((method, params) => this.handleNotification(method, params));
		connection.onRequest((method, params) => this.handleRequest(method, params));
		connection.onClose((reason) => this.handleClose(reason));

		try {
			const init = await withTimeout(
				connection.request("initialize", {
					protocolVersion: ACP_PROTOCOL_VERSION,
					// Files and commands stay with the agent; this client renders and approves.
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
					clientInfo: { name: "nekocode", title: "NekoCode", version: this.options.clientVersion },
				}),
				STARTUP_TIMEOUT_MS,
				`${this.agent.name} 启动超时`,
			);
			if (isObject(init)) {
				const capabilities = isObject(init.agentCapabilities) ? init.agentCapabilities : {};
				const prompt = isObject(capabilities.promptCapabilities) ? capabilities.promptCapabilities : {};
				this.supportsImages = prompt.image === true;
				this.authMethods = (Array.isArray(init.authMethods) ? init.authMethods : [])
					.filter(isObject)
					.map((method) => str(method.name) ?? str(method.id) ?? "")
					.filter(Boolean);
			}

			const capabilities = isObject(init) && isObject(init.agentCapabilities) ? init.agentCapabilities : {};
			const auth = this.agent.native?.auth;
			let authenticated = false;
			const authenticate = async () => {
				authenticated = true;
				await withTimeout(
					authenticateAgent(
						(method, params) => connection.request(method, params),
						auth!,
						init,
						this.options.env ?? { ...process.env, ...this.agent.native?.env, ...this.agent.env },
						this.agent.name,
					),
					STARTUP_TIMEOUT_MS,
					`${this.agent.name} 登录超时`,
				);
			};
			if (auth?.when === "always") await authenticate();
			if (this.disposed) return;
			await differ;
			await this.attachTools(capabilities);
			if (this.disposed) return;
			const setUp = () =>
				this.options.resume
					? this.reopen(connection, this.options.resume.sessionId, capabilities)
					: withTimeout(
							connection.request("session/new", this.sessionParams()),
							STARTUP_TIMEOUT_MS,
							`${this.agent.name} 创建会话超时`,
						);
			let setup: unknown;
			try {
				setup = await setUp();
			} catch (error) {
				if (!(error instanceof AcpRpcError && error.code === AUTH_REQUIRED)) throw error;
				// Signing in when asked to, once; an agent that still refuses gets the hint.
				if (!auth || authenticated) throw new Error(this.authHint());
				await authenticate();
				if (this.disposed) return;
				try {
					setup = await setUp();
				} catch (retryError) {
					if (retryError instanceof AcpRpcError && retryError.code === AUTH_REQUIRED) throw new Error(this.authHint());
					throw retryError;
				}
			}
			const sessionId = this.options.resume?.sessionId ?? (isObject(setup) ? str(setup.sessionId) : undefined);
			if (!sessionId) throw new Error(`${this.agent.name} 没有返回会话 ID`);
			this.agentSessionId = sessionId;
			this.projection.applySessionSetup(setup);
			if (this.disposed) return;
			this.status = "ready";
			this.changed();
		} catch (error) {
			if (this.disposed) return;
			this.fail(errorText(error));
			connection.close(errorText(error));
		}
	}

	/** What session/new, load and resume all take. */
	private sessionParams(): Record<string, unknown> {
		const meta = this.agent.bundled?.sessionMeta;
		return { cwd: this.cwd, mcpServers: this.mcpServers, ...(meta ? { _meta: meta } : {}) };
	}

	/**
	 * Reopen a conversation the agent already has. `session/load` replays it as
	 * ordinary updates, which is what fills the transcript; `session/resume`
	 * reconnects without history, the fallback for agents that only offer that.
	 */
	private async reopen(connection: AcpConnection, sessionId: string, capabilities: Record<string, unknown>): Promise<unknown> {
		// Set before the call: the replay arrives before its response does.
		this.agentSessionId = sessionId;
		const sessionCapabilities = isObject(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
		const params = { sessionId, ...this.sessionParams() };
		if (capabilities.loadSession === true) {
			const result = await withTimeout(connection.request("session/load", params), STARTUP_TIMEOUT_MS, `${this.agent.name} 加载会话超时`);
			this.projection.finishReplay();
			if (this.options.processCwd) {
				this.projection.addNotice("warning", `项目目录已不存在：${this.cwd}。可以查看这段历史，但继续对话时代理将无法访问项目文件。`);
			}
			return result;
		}
		if (sessionCapabilities.resume !== undefined) {
			const result = await withTimeout(connection.request("session/resume", params), STARTUP_TIMEOUT_MS, `${this.agent.name} 恢复会话超时`);
			this.projection.addNotice("info", "该代理只支持恢复会话，不支持回放历史消息；可以直接继续对话。");
			return result;
		}
		throw new Error(`${this.agent.name} 不支持打开历史会话`);
	}

	/**
	 * Give the agent NekoCode's tools. Every ACP agent must take stdio servers;
	 * HTTP is optional and advertised, and ours is HTTP because the tools run in
	 * this process. An agent without it simply goes without them.
	 */
	private async attachTools(capabilities: Record<string, unknown>): Promise<void> {
		if (!this.options.toolServers) return;
		try {
			this.tools = await this.options.toolServers();
		} catch (error) {
			this.projection.addNotice("warning", `NekoCode 工具不可用：${errorText(error)}`);
			return;
		}
		if (this.disposed) {
			this.tools.dispose();
			return;
		}
		const mcp = isObject(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
		if (mcp.http === true) {
			this.mcpServers = this.tools.servers;
			return;
		}
		this.tools.dispose();
		this.tools = null;
		this.projection.addNotice("info", `${this.agent.name} 不支持通过 HTTP 接入 MCP 工具，本会话无法使用 NekoCode 的浏览器、Computer Use 等工具。`);
	}

	private authHint(): string {
		const methods = this.authMethods.length > 0 ? `（代理支持：${this.authMethods.join("、")}）` : "";
		return `${this.agent.name} 需要登录${methods}。请先在终端里完成该代理自己的登录，或设置它的 API Key 环境变量，然后重新创建会话。`;
	}

	private fail(message: string): void {
		recordDiagnostic("acp.sessionFailed", { sessionId: this.id, agentId: this.agent.id, message: message.slice(0, 2048) });
		this.status = "error";
		this.error = message;
		this.cancelRetryWait?.();
		// Nothing can call the tools any more; their token should not outlive that.
		this.tools?.dispose();
		this.tools = null;
		this.shell?.dispose();
		this.shell = null;
		this.cancelPermissions();
		this.changed();
	}

	private handleNotification(method: string, params: unknown): void {
		if (method === "_claude/sdkMessage") {
			if (this.agent.id !== "claude" || !isObject(params) || params.sessionId !== this.agentSessionId) return;
			const message = params.message;
			if (!isObject(message) || message.type !== "result") return;
			const duration = message.duration_api_ms;
			if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 1) return;
			// A decreasing counter means the CLI reset its ledger (for example /clear).
			if (this.lastApiDurationMs !== undefined && duration < this.lastApiDurationMs) this.attemptApiDurationStart = 0;
			this.lastApiDurationMs = duration;
			if (this.status === "prompting" && this.promptDispatched && this.attemptApiDurationStart !== undefined) {
				const elapsed = duration - this.attemptApiDurationStart;
				if (elapsed >= 1) this.modelMs = elapsed;
			}
			return;
		}
		if (method !== "session/update" || !isObject(params)) return;
		if (this.agentSessionId && params.sessionId !== this.agentSessionId) return;
		if (this.projection.apply(params.update)) this.changed();
		this.watchShell(params.update);
	}

	/**
	 * Edits are noted so their files are not shown twice; a command that has
	 * finished is checked for the files it changed.
	 */
	private watchShell(update: unknown): void {
		const shell = this.shell;
		if (!shell || !isObject(update)) return;
		if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
		const toolCallId = str(update.toolCallId);
		const raw = toolCallId ? this.projection.toolCall(toolCallId) : undefined;
		if (!toolCallId || !raw) return;
		const finished = raw.status === "completed" || raw.status === "failed";
		if (raw.kind === "edit" || raw.kind === "delete" || raw.kind === "move" || diffPaths(raw).length > 0) {
			shell.noteEdit(toolCallId, editedPaths(raw), finished);
			return;
		}
		// An MCP tool Codex reports as `execute` is not a shell command.
		if (raw.kind !== "execute" || !finished || (isObject(raw.rawInput) && typeof raw.rawInput.server === "string")) return;
		if (this.settledCommands.has(toolCallId)) return;
		this.settledCommands.add(toolCallId);
		void shell.settle().then((changes) => {
			if (!this.disposed && this.projection.addShellChanges(toolCallId, changes)) this.changed();
		});
	}

	private async handleRequest(method: string, params: unknown): Promise<unknown> {
		if (method === "session/request_permission") return this.requestPermission(params);
		throw new AcpRpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
	}

	private requestPermission(params: unknown): Promise<unknown> {
		const input = isObject(params) ? params : {};
		const toolCall = isObject(input.toolCall) ? input.toolCall : {};
		const toolCallId = str(toolCall.toolCallId);
		// Show what is being approved: the call may not have been announced yet.
		if (toolCallId) {
			this.projection.apply({ ...toolCall, sessionUpdate: "tool_call_update", toolCallId });
		}
		const options = (Array.isArray(input.options) ? input.options : []).filter(isObject).flatMap((option) => {
			const optionId = str(option.optionId);
			if (!optionId) return [];
			const kind = PERMISSION_KINDS.has(option.kind as AcpPermissionOptionKind)
				? (option.kind as AcpPermissionOptionKind)
				: "allow_once";
			return [{ optionId, name: str(option.name) ?? optionId, kind }];
		});
		const id = `perm-${this.nextPermission++}`;
		const title = str(toolCall.title) ?? str(toolCall.kind) ?? "工具调用";
		const detail = toolCallId ? this.projection.toolDetail(toolCallId) : undefined;
		return new Promise((resolve) => {
			this.permissions.set(id, {
				request: {
					id,
					...(toolCallId ? { toolCallId } : {}),
					title,
					...(detail && detail !== title ? { detail } : {}),
					options,
				},
				resolve,
			});
			this.changed();
		});
	}

	respondPermission(requestId: string, optionId: string | null): void {
		const pending = this.permissions.get(requestId);
		if (!pending) return;
		this.permissions.delete(requestId);
		const valid = optionId !== null && pending.request.options.some((option) => option.optionId === optionId);
		pending.resolve({ outcome: valid ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
		this.changed();
	}

	private cancelPermissions(): void {
		for (const pending of this.permissions.values()) pending.resolve({ outcome: { outcome: "cancelled" } });
		this.permissions.clear();
	}

	private handleClose(reason: string): void {
		if (this.disposed) return;
		if (this.status === "prompting") this.projection.failTurn(`${this.agent.name} 已退出：${reason}`);
		this.fail(reason);
	}

	private requireReady(): { connection: AcpConnection; sessionId: string } {
		if (this.status === "starting") throw new Error(`${this.agent.name} 还在启动`);
		if (this.status === "error" || !this.connection || !this.agentSessionId) {
			throw new Error(this.error ?? `${this.agent.name} 不可用`);
		}
		return { connection: this.connection, sessionId: this.agentSessionId };
	}

	/** Closed by the user or died mid-turn; either way the turn's end is moot. */
	private gone(): boolean {
		return this.disposed || this.status === "error";
	}

	/** Run one turn. Resolves when the agent finishes it, however it ends. */
	async prompt(text: string, images: PromptImageAttachment[] = []): Promise<void> {
		// Reserve the turn before startup/configuration awaits. Otherwise two
		// first messages both resume the handshake and enter session/prompt.
		if (this.promptPending || this.status === "prompting") throw new Error("上一轮还没有结束");
		this.promptPending = true;
		this.promptDispatched = false;
		this.queuedPromptCancelled = false;
		this.modelMs = undefined;
		try {
			await this.promptOnce(text, images);
		} finally {
			this.promptPending = false;
			this.promptDispatched = false;
		}
	}

	private async promptOnce(text: string, images: PromptImageAttachment[]): Promise<void> {
		if (!text && images.length === 0) return;
		recordDiagnostic("acp.promptQueued", { sessionId: this.id, agentId: this.agent.id, starting: this.status === "starting" });
		this.prompted = true;
		if (this.status === "starting") {
			// The first prompt of a new conversation is sent while the agent is
			// still starting: show it now, send it once the handshake is done.
			this.projection.addUserPrompt(userText(text, images));
			this.changed();
			await this.started;
			if (this.gone()) return;
			if (this.queuedPromptCancelled) {
				this.projection.finishTurn("cancelled");
				this.changed();
				return;
			}
			return this.send(text, images);
		}
		this.requireReady();
		this.projection.addUserPrompt(userText(text, images));
		return this.send(text, images);
	}

	private async send(text: string, images: PromptImageAttachment[]): Promise<void> {
		const { connection, sessionId } = this.requireReady();
		if (images.length > 0 && !this.supportsImages) {
			this.projection.failTurn(`${this.agent.name} 不支持图片输入`);
			this.changed();
			return;
		}
		const prompt: unknown[] = [];
		if (text) prompt.push({ type: "text", text });
		for (const image of images) prompt.push({ type: "image", mimeType: image.mimeType, data: image.data });
		this.status = "prompting";
		this.changed();
		const startedAt = this.now();
		const configuring = this.pendingConfig;
		try {
			await configuring;
			await this.shellOpening;
			if (this.gone()) return;
			if (this.queuedPromptCancelled) {
				this.projection.finishTurn("cancelled");
				this.status = "ready";
				this.changed();
				return;
			}
			// Commands queue their change checks behind this baseline snapshot.
			void this.shell?.begin();
			recordDiagnostic("acp.prompt", { sessionId: this.id, agentId: this.agent.id });
			this.promptDispatched = true;
			const configuredRetries = this.options.autoRetryCount?.() ?? DEFAULT_APP_PREFERENCES.autoRetryCount;
			const maxRetries = isAutoRetryCount(configuredRetries) ? configuredRetries : DEFAULT_APP_PREFERENCES.autoRetryCount;
			let result: unknown;
			let retries = 0;
			let nextPrompt = prompt;
			while (true) {
				try {
					// Each ACP attempt has its own output-token total. Exclude prior
					// turns and failed attempts from the matching timing denominator.
					this.attemptApiDurationStart = this.lastApiDurationMs;
					this.modelMs = undefined;
					result = await connection.request("session/prompt", { sessionId, prompt: nextPrompt });
					break;
				} catch (error) {
					if (this.gone()) return;
					if (this.queuedPromptCancelled) {
						result = { stopReason: "cancelled" };
						break;
					}
					if (connection.closed || !retryableToolProtocolError(error) || retries >= maxRetries) throw error;
					retries++;
					this.projection.prepareRetry();
					this.cancelPermissions();
					const delayMs = Math.min((this.options.retryDelayMs ?? 1000) * 2 ** (retries - 1), 8000);
					this.projection.addNotice("info", `工具调用协议异常，正在自动重试（${retries}/${maxRetries}）…`);
					recordDiagnostic("acp.promptRetry", { sessionId: this.id, agentId: this.agent.id, attempt: retries, maxRetries, delayMs, ...diagnosticError(error) });
					this.changed();
					await this.waitForRetry(delayMs);
					if (this.gone()) return;
					if (this.queuedPromptCancelled) {
						result = { stopReason: "cancelled" };
						break;
					}
					// Continue within the agent's existing context instead of replaying
					// the original task, whose earlier tool calls may already have run.
					nextPrompt = [{ type: "text", text: RETRY_CONTINUATION }];
				}
			}
			const response = isObject(result) ? result : {};
			recordDiagnostic("acp.promptCompleted", {
				sessionId: this.id, agentId: this.agent.id, stopReason: str(response.stopReason), durationMs: this.now() - startedAt,
			});
			const usage = turnUsageFromAcp(response.usage, this.now() - startedAt, this.modelMs);
			if (this.agent.id === "claude") recordDiagnostic("acp.turnTiming", {
				sessionId: this.id, outputTokens: usage?.output, modelMs: this.modelMs,
				apiDurationStart: this.attemptApiDurationStart, apiDurationEnd: this.lastApiDurationMs,
			});
			this.projection.finishTurn(
				str(response.stopReason) ?? "end_turn",
				usage,
				this.agent.name,
			);
			if (usage) {
				try {
					this.options.onUsage?.({ ...usage, provider: this.agent.name, model: this.projection.currentModel() }, this.now());
				} catch (error) {
					console.error("Failed to record ACP token usage", error);
				}
			}
		} catch (error) {
			if (this.gone()) return;
			recordDiagnostic("acp.promptFailed", { sessionId: this.id, agentId: this.agent.id, ...diagnosticError(error) });
			this.projection.failTurn(errorText(error));
		}
		void this.shell?.end();
		if (this.gone()) return;
		this.cancelPermissions();
		this.status = "ready";
		this.changed();
	}

	/** Ask the agent to stop the running turn; `prompt()` resolves once it has. */
	async cancel(): Promise<void> {
		this.queuedPromptCancelled = true;
		if (this.cancelRetryWait) {
			this.cancelRetryWait();
			return;
		}
		if (this.promptPending && !this.promptDispatched) {
			return;
		}
		if (this.status !== "prompting" || !this.connection || !this.agentSessionId) return;
		// The spec requires open permission prompts to be answered as cancelled.
		this.cancelPermissions();
		this.changed();
		await this.connection.notify("session/cancel", { sessionId: this.agentSessionId });
	}

	private waitForRetry(delayMs: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.cancelRetryWait = null;
				resolve();
			};
			const timer = setTimeout(done, delayMs);
			this.cancelRetryWait = done;
		});
	}

	setConfig(configId: string, value: string): Promise<void> {
		if (this.promptPending || this.status === "prompting") return Promise.reject(new Error("请等待当前运行结束后再修改配置"));
		const change = this.configTail.then(() => this.applyConfig(configId, value));
		this.pendingConfig = change;
		this.configTail = change.catch(() => undefined);
		const clear = () => { if (this.pendingConfig === change) this.pendingConfig = null; };
		void change.then(
			() => {
				clear();
				recordDiagnostic("acp.configApplied", { sessionId: this.id, agentId: this.agent.id, configId });
			},
			(error: unknown) => {
				clear();
				recordDiagnostic("acp.configFailed", { sessionId: this.id, agentId: this.agent.id, configId, ...diagnosticError(error) });
			},
		);
		return change;
	}

	private async applyConfig(configId: string, value: string): Promise<void> {
		const { connection, sessionId } = this.requireReady();
		if (configId === MODE_CONFIG_ID) {
			await connection.request("session/set_mode", { sessionId, modeId: value });
			this.projection.setCurrentMode(value);
		} else if (configId === MODEL_CONFIG_ID) {
			await connection.request("session/set_model", { sessionId, modelId: value });
			this.projection.setCurrentModel(value);
		} else {
			const result = await connection.request("session/set_config_option", { sessionId, configId, value });
			if (isObject(result) && Array.isArray(result.configOptions)) {
				this.projection.setConfigOptions(result.configOptions);
			}
		}
		this.changed();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelRetryWait?.();
		this.shell?.dispose();
		this.shell = null;
		this.tools?.dispose();
		this.tools = null;
		this.cancelPermissions();
		this.connection?.close("会话已关闭");
		this.connection = null;
	}
}
