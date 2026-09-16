import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { app, type BrowserWindow } from "electron";
import type {
	AgentSession,
	AgentSessionEvent,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentSnapshot,
	ExecutionMode,
	ModelOption,
	OpenThreadRequest,
	SendPromptRequest,
	SendPromptResult,
	ThreadSummary,
	ThinkingLevel,
} from "../shared/agent";
import type { ModelTestRequest, ModelTestResult } from "../shared/settings";
import {
	CellProjector,
	parseSlashCommand,
	type ProjectionEvent,
} from "./agent-projection";
import type { ModelConfigService } from "./model-config-service";
import { decideModelAfterReload } from "./model-refresh";
import { pi } from "./pi";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const FULL_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const HELP_TEXT = [
	"/help — list commands",
	"/new, /clear — start a new thread",
	"/abort — stop the current run",
	"/compact — compact context",
	"/model [provider/id] — list or select a model",
	"/thinking <level> — set thinking level",
	"/terminal — open the terminal drawer",
].join("\n");

const NO_MODEL_ERROR =
	"No model configured. Add credentials to ~/.pi/agent/auth.json or set a provider API key environment variable, then restart.";

const MODES: ExecutionMode[] = ["read-only", "auto", "full-access"];

function assertDirectory(cwd: string): void {
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
		throw new Error(`Not a directory: ${cwd}`);
	}
}

function modelKeyOf(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export class AgentService {
	private session: AgentSession | null = null;
	private unsubscribe: (() => void) | null = null;
	private projector = new CellProjector();
	private mode: ExecutionMode = "auto";
	private modelRuntimePromise: Promise<ModelRuntime> | null = null;
	private runtime: ModelRuntime | null = null;
	private sessionDir: string;
	private createdAt = Date.now();
	private pendingError: string | undefined;
	private generation = 0;
	private customProviderIds = new Set<string>();

	constructor(
		private readonly win: BrowserWindow,
		private readonly modelConfig: ModelConfigService,
	) {
		this.sessionDir = join(app.getPath("userData"), "sessions");
		mkdirSync(this.sessionDir, { recursive: true });
	}

	/**
	 * The app's single PI model runtime. Exposed so headless automation runs share
	 * it: provider registration and credentials are global to the runtime, so a
	 * second instance would duplicate them.
	 */
	getModelRuntime(): Promise<ModelRuntime> {
		if (!this.modelRuntimePromise) {
			this.modelRuntimePromise = pi()
				.then((m) => m.ModelRuntime.create())
				.then((runtime) => {
					this.runtime = runtime;
					this.registerProfiles();
					return runtime;
				});
		}
		return this.modelRuntimePromise;
	}

	private registerProfiles(): void {
		const runtime = this.runtime;
		if (!runtime) return;
		for (const id of this.customProviderIds) {
			runtime.unregisterProvider(id);
		}
		this.customProviderIds.clear();
		for (const profile of this.modelConfig.registrationProfiles()) {
			runtime.registerProvider(profile.providerId, {
				name: profile.name,
				baseUrl: profile.sdkBaseUrl,
				apiKey: profile.apiKey,
				api: profile.api,
				authHeader:
					profile.api === "openai-completions" ||
					profile.api === "openai-responses",
				models: profile.modelIds.map((id) => ({
					id,
					name: id,
					api: profile.api,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				})),
			});
			this.customProviderIds.add(profile.providerId);
		}
	}

	/** Re-register custom providers after profile save/delete. */
	async reloadConfiguredModels(): Promise<void> {
		const session = this.session;
		const current = session?.model ?? null;
		await this.getModelRuntime();
		this.registerProfiles();
		if (session && this.runtime) {
			const runtime = this.runtime;
			const firstCustom =
				runtime
					.getAvailableSnapshot()
					.filter((m) => this.customProviderIds.has(m.provider))
					.map((m) => ({ provider: m.provider, id: m.id }))[0] ?? null;
			const decision = decideModelAfterReload({
				current: current
					? { provider: current.provider, id: current.id }
					: null,
				isRegistered: (p, id) => runtime.getModel(p, id) !== undefined,
				firstCustom,
			});
			if (decision.kind === "set") {
				try {
					const refreshed = runtime.getModel(
						decision.model.provider,
						decision.model.id,
					);
					if (refreshed) {
						await session.setModel(refreshed);
						this.pendingError = undefined;
					} else {
						this.pendingError = `模型配置刷新失败: 模型 ${decision.model.provider}/${decision.model.id} 未注册`;
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					this.pendingError =
						`模型配置刷新失败: ${message}`.slice(0, 500);
				}
			} else if (decision.kind === "removed") {
				this.pendingError =
					"当前模型配置已被移除，请添加或选择可用模型";
			}
		}
		this.emit();
	}

	async testConfiguredModel(req: ModelTestRequest): Promise<ModelTestResult> {
		const start = Date.now();
		try {
			const runtime = await this.getModelRuntime();
			const model = runtime.getModel(
				`nekocode-${req.profileId}`,
				req.modelId,
			);
			if (!model) {
				return {
					ok: false,
					latencyMs: Date.now() - start,
					message: "模型未注册，请先保存配置",
				};
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 20_000);
			try {
				const message = await runtime.completeSimple(model, {
					messages: [
						{
							role: "user",
							content: "Reply with exactly OK.",
							timestamp: Date.now(),
						},
					],
				}, { maxTokens: 8, signal: controller.signal });
				const text = Array.isArray(message.content)
					? message.content
							.filter(
								(c): c is { type: "text"; text: string } =>
									c.type === "text",
							)
							.map((c) => c.text)
							.join("")
							.trim()
					: "";
				const ok =
					message.stopReason !== "error" &&
					message.stopReason !== "aborted" &&
					text.length > 0;
				return {
					ok,
					latencyMs: Date.now() - start,
					message: ok
						? "成功"
						: (
								message.errorMessage ??
								`stopReason: ${message.stopReason}`
							).slice(0, 500),
					output: text.slice(0, 300),
				};
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				latencyMs: Date.now() - start,
				message: raw.slice(0, 500),
			};
		}
	}

	async listThreads(cwd: string): Promise<ThreadSummary[]> {
		assertDirectory(cwd);
		const { SessionManager } = await pi();
		const sessions = await SessionManager.list(cwd, this.sessionDir);
		return sessions.map((s) => ({
			id: s.id,
			sessionFile: s.path,
			cwd: s.cwd || cwd,
			title: s.name || s.firstMessage.trim().slice(0, 80) || "New chat",
			createdAt: s.created.getTime(),
			updatedAt: s.modified.getTime(),
			messageCount: s.messageCount,
		}));
	}

	async createThread(cwd: string): Promise<AgentSnapshot> {
		assertDirectory(cwd);
		const { SessionManager } = await pi();
		const sessionManager = SessionManager.create(cwd, this.sessionDir);
		return this.startSession(sessionManager);
	}

	async openThread(req: OpenThreadRequest): Promise<AgentSnapshot> {
		assertDirectory(req.cwd);
		const sessionDir = resolve(this.sessionDir);
		const sessionFile = resolve(req.sessionFile);
		if (!sessionFile.startsWith(sessionDir + sep)) {
			throw new Error(`Session file outside session dir: ${req.sessionFile}`);
		}
		if (!existsSync(sessionFile) || !statSync(sessionFile).isFile()) {
			throw new Error(`Session file does not exist: ${req.sessionFile}`);
		}
		const { SessionManager } = await pi();
		const sessionManager = SessionManager.open(
			sessionFile,
			this.sessionDir,
			req.cwd,
		);
		return this.startSession(sessionManager);
	}

	getSnapshot(): AgentSnapshot | null {
		return this.session ? this.buildSnapshot() : null;
	}

	async send(req: SendPromptRequest): Promise<SendPromptResult> {
		const session = this.session;
		if (!session) return { accepted: false, error: "No active thread" };
		const text = req.text;
		if (!text.trim()) return { accepted: false, error: "Empty message" };

		const slash = parseSlashCommand(text);
		if (slash) {
			const handled = await this.handleSlash(slash.command, slash.args);
			if (handled) return handled;
		}

		if (!session.model || session.model.provider === "unknown") {
			this.projector.notice("error", NO_MODEL_ERROR);
			this.emit();
			return { accepted: false, error: NO_MODEL_ERROR };
		}
		if (!this.isModelUsable(session.model)) {
			const msg = "当前模型配置已被移除，请添加或选择可用模型";
			this.projector.notice("error", msg);
			this.emit();
			return { accepted: false, error: msg };
		}

		const firstPrompt = !session.messages.some((m) => m.role === "user");
		if (firstPrompt) {
			session.setSessionName(text.trim().replace(/\s+/g, " ").slice(0, 80));
		}

		try {
			if (session.isStreaming) {
				await session.prompt(text, { streamingBehavior: "steer" });
			} else {
				session.prompt(text).catch((error: unknown) => {
					this.projector.notice(
						"error",
						error instanceof Error ? error.message : String(error),
					);
					this.emit();
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.projector.notice("error", message);
			this.emit();
			return { accepted: false, error: message };
		}
		return { accepted: true };
	}

	async abort(): Promise<void> {
		await this.session?.abort();
		this.emit();
	}

	async setModel(modelKey: string): Promise<AgentSnapshot> {
		const runtime = await this.getModelRuntime();
		const model = runtime
			.getAvailableSnapshot()
			.find((m) => modelKeyOf(m) === modelKey);
		if (!model) throw new Error(`Unknown model: ${modelKey}`);
		if (!this.session) throw new Error("No active thread");
		await this.session.setModel(model);
		this.pendingError = undefined;
		const snapshot = this.buildSnapshot();
		this.emit();
		return snapshot;
	}

	setThinkingLevel(level: ThinkingLevel): AgentSnapshot {
		if (!this.session) throw new Error("No active thread");
		if (!THINKING_LEVELS.includes(level)) {
			throw new Error(`Unknown thinking level: ${level}`);
		}
		this.session.setThinkingLevel(level);
		const snapshot = this.buildSnapshot();
		this.emit();
		return snapshot;
	}

	setMode(mode: ExecutionMode): AgentSnapshot {
		if (!MODES.includes(mode)) {
			throw new Error(`Unknown execution mode: ${String(mode)}`);
		}
		if (!this.session) throw new Error("No active thread");
		this.mode = mode;
		this.session.setActiveToolsByName(
			mode === "read-only" ? READ_ONLY_TOOLS : FULL_TOOLS,
		);
		const snapshot = this.buildSnapshot();
		this.emit();
		return snapshot;
	}

	close(): void {
		this.generation++;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.session?.dispose();
		this.session = null;
	}

	private async startSession(
		sessionManager: SessionManager,
	): Promise<AgentSnapshot> {
		const generation = ++this.generation;
		// This transition owns the currently-active session; dispose it now.
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.session?.dispose();
		this.session = null;
		this.projector.reset();
		this.pendingError = undefined;

		const { createAgentSession } = await pi();
		const modelRuntime = await this.getModelRuntime();
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: sessionManager.getCwd(),
			sessionManager,
			modelRuntime,
		});
		if (generation !== this.generation) {
			session.dispose();
			throw new Error("Session superseded");
		}
		this.runtime = modelRuntime;
		this.session = session;
		this.createdAt = Date.now();
		session.setActiveToolsByName(
			this.mode === "read-only" ? READ_ONLY_TOOLS : FULL_TOOLS,
		);
		if (!session.model || session.model.provider === "unknown") {
			this.pendingError = modelFallbackMessage ?? NO_MODEL_ERROR;
		} else if (modelFallbackMessage) {
			this.projector.notice("warning", modelFallbackMessage);
		}
		this.projector.rebuild(session.messages);
		this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			this.onSessionEvent(event);
		});
		const snapshot = this.buildSnapshot();
		this.emit(snapshot);
		return snapshot;
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		if (!this.session) return;
		this.projector.handleEvent(event as ProjectionEvent);
		this.projector.rebuild(this.session.messages);
		this.emit();
	}

	private async handleSlash(
		command: string,
		args: string,
	): Promise<SendPromptResult | null> {
		const session = this.session;
		if (!session) return { accepted: false, error: "No active thread" };
		switch (command) {
			case "help":
				this.projector.notice("info", HELP_TEXT);
				this.emit();
				return { accepted: true };
			case "new":
			case "clear":
				return { accepted: true, action: "new-thread" };
			case "abort":
				await session.abort();
				this.emit();
				return { accepted: true };
			case "compact":
				session
					.compact()
					.catch((error: unknown) => {
						this.projector.notice(
							"error",
							error instanceof Error ? error.message : String(error),
						);
						this.emit();
					});
				return { accepted: true };
			case "model": {
				if (!args) {
					const models = this.modelOptions();
					this.projector.notice(
						"info",
						models.length
							? models.map((m) => m.key).join("\n")
							: "No models available",
					);
					this.emit();
					return { accepted: true };
				}
				try {
					await this.setModel(args);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					this.projector.notice("error", message);
					this.emit();
					return { accepted: false, error: message };
				}
				return { accepted: true };
			}
			case "thinking": {
				if (!THINKING_LEVELS.includes(args as ThinkingLevel)) {
					const message = `Unknown thinking level: ${args || "(empty)"}. Levels: ${THINKING_LEVELS.join(", ")}`;
					this.projector.notice("error", message);
					this.emit();
					return { accepted: false, error: message };
				}
				this.setThinkingLevel(args as ThinkingLevel);
				return { accepted: true };
			}
			case "terminal":
				return { accepted: true, action: "open-terminal" };
			default:
				// Unknown slash commands go through prompt() so skills, prompt
				// templates, and extension commands still work.
				return null;
		}
	}

	/** A custom model must still be registered; built-ins are always usable. */
	private isModelUsable(model: { provider: string; id: string }): boolean {
		if (!model.provider.startsWith("nekocode-")) return true;
		if (!this.runtime) return false;
		return this.runtime.getModel(model.provider, model.id) !== undefined;
	}

	private modelOptions(): ModelOption[] {
		if (!this.runtime) return [];
		return this.runtime.getAvailableSnapshot().map((m) => ({
			key: modelKeyOf(m),
			provider: m.provider,
			id: m.id,
			name: m.name,
		}));
	}

	private buildSnapshot(): AgentSnapshot {
		const session = this.session;
		if (!session) throw new Error("No active thread");
		const sm = session.sessionManager;
		const messages = session.messages;
		const sessionFile = sm.getSessionFile() ?? "";
		let createdAt = this.createdAt;
		if (sessionFile && existsSync(sessionFile)) {
			try {
				createdAt = statSync(sessionFile).birthtimeMs || this.createdAt;
			} catch {
				// keep fallback
			}
		}
		const firstUser = messages.find((m) => m.role === "user");
		const firstText =
			firstUser && typeof firstUser.content === "string"
				? firstUser.content
				: "";
		const model = session.model;
		return {
			thread: {
				id: sm.getSessionId(),
				sessionFile,
				cwd: sm.getCwd(),
				title:
					sm.getSessionName() ||
					firstText.trim().slice(0, 80) ||
					"New chat",
				createdAt,
				updatedAt: Date.now(),
				messageCount: messages.length,
			},
			cells: this.projector.cells(),
			streaming: session.isStreaming,
			modelKey:
				model &&
				model.provider !== "unknown" &&
				this.isModelUsable(model)
					? modelKeyOf(model)
					: null,
			models: this.modelOptions(),
			thinkingLevel: session.thinkingLevel,
			mode: this.mode,
			error: this.pendingError,
		};
	}

	private emit(snapshot?: AgentSnapshot): void {
		if (this.win.isDestroyed()) return;
		this.win.webContents.send("agent:snapshot", snapshot ?? this.buildSnapshot());
	}
}
