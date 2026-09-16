import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { app, type BrowserWindow } from "electron";
import type {
	AgentSession,
	AgentSessionEvent,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	AgentDefaults,
	AgentSnapshot,
	DeleteSessionRequest,
	ExecutionMode,
	ModelOption,
	OpenSessionRequest,
	RenameSessionRequest,
	SendPromptRequest,
	SendPromptResult,
	SessionSummary,
	ThinkingLevel,
} from "../shared/agent";
import { normalizeLine, sessionTitle } from "../shared/sessions";
import type { ModelTestRequest, ModelTestResult } from "../shared/settings";
import {
	CellProjector,
	parseSlashCommand,
	type ProjectionEvent,
} from "./agent-projection";
import type { ModelConfigService } from "./model-config-service";
import { decideModelAfterReload } from "./model-refresh";
import { pi, piAi } from "./pi";

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
	"/new, /clear — start a new session",
	"/abort — stop the current run",
	"/compact — compact context",
	"/model [provider/id] — list or select a model",
	"/thinking <level> — set thinking level",
	"/terminal — open the terminal drawer",
].join("\n");

const NO_MODEL_ERROR =
	"No model configured. Add credentials to ~/.pi/agent/auth.json or set a provider API key environment variable, then restart.";

const MODES: ExecutionMode[] = ["read-only", "auto", "full-access"];

/**
 * Preferred model per provider when nothing is configured — a verbatim copy of
 * `defaultModelPerProvider` from pi's model-resolver (vendored pi@0.85.1), which
 * the package does not re-export. Keep in sync when bumping pi.
 */
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"ant-ling": "Ring-2.6-1T",
	anthropic: "claude-opus-4-8",
	openai: "gpt-5.5",
	"azure-openai-responses": "gpt-5.4",
	"openai-codex": "gpt-5.5",
	radius: "balanced",
	nvidia: "nvidia/nemotron-3-super-120b-a12b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-5.4",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.6",
	groq: "openai/gpt-oss-120b",
	cerebras: "gpt-oss-120b",
	zai: "glm-5.3",
	"zai-coding-cn": "glm-5.3",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k2p6",
	together: "moonshotai/Kimi-K2.6",
	baseten: "zai-org/GLM-5.2",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k2.6",
	"kimi-coding": "kimi-for-coding",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	"qwen-token-plan": "qwen3.7-max",
	"qwen-token-plan-cn": "qwen3.7-max",
	"qwen-token-plan-individual": "qwen3.8-max",
	xiaomi: "mimo-v2.5-pro",
	"xiaomi-token-plan-cn": "mimo-v2.5-pro",
	"xiaomi-token-plan-ams": "mimo-v2.5-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

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
	private wasStreaming = false;
	private customProviderIds = new Set<string>();
	/**
	 * Composer picks made on the welcome screen, applied to the next new session
	 * (opening an existing session restores its own model instead). In-session
	 * picks feed back here too, so the choice is one global "last selected".
	 */
	private pendingModelKey: string | null = null;
	private pendingThinkingLevel: ThinkingLevel | null = null;
	/** Last directory the renderer asked about — where pushed defaults apply. */
	private cwd: string | null = null;
	private readonly preferencesPath: string;

	constructor(
		private readonly win: BrowserWindow,
		private readonly modelConfig: ModelConfigService,
	) {
		this.sessionDir = join(app.getPath("userData"), "sessions");
		mkdirSync(this.sessionDir, { recursive: true });
		this.preferencesPath = join(app.getPath("userData"), "preferences.json");
		this.loadPreferences();
	}

	/**
	 * App-level prefs that are not pi settings — currently just the execution
	 * mode. Missing or corrupt files fall back to "auto".
	 */
	private loadPreferences(): void {
		try {
			const raw: unknown = JSON.parse(
				readFileSync(this.preferencesPath, "utf8"),
			);
			const mode = (raw as { mode?: unknown }).mode;
			if (MODES.includes(mode as ExecutionMode)) {
				this.mode = mode as ExecutionMode;
			}
		} catch {
			// First launch or a torn file — the default stands.
		}
	}

	private savePreferences(): void {
		try {
			writeFileSync(this.preferencesPath, `${JSON.stringify({ mode: this.mode })}\n`);
		} catch {
			// Best-effort — the pick still applies for this run.
		}
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
					// PI clamps every thinking level to "off" on a model that is not
					// flagged as reasoning, so this is what makes the picker do anything.
					reasoning: profile.reasoning,
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
		// The welcome screen's model list and resolved default change with the
		// available set too — it is showing even though emit() reported null.
		this.emitDefaults();
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

	async listSessions(cwd: string): Promise<SessionSummary[]> {
		assertDirectory(cwd);
		const { SessionManager } = await pi();
		const sessions = await SessionManager.list(cwd, this.sessionDir);
		return sessions.map((s) => ({
			id: s.id,
			sessionFile: s.path,
			cwd: s.cwd || cwd,
			title: sessionTitle(s.name, s.firstMessage),
			// Only renamed sessions get a second line: for the rest the title
			// already is the opening prompt, and repeating it reads as noise.
			preview: s.name?.trim() ? normalizeLine(s.firstMessage, 160) : "",
			createdAt: s.created.getTime(),
			updatedAt: s.modified.getTime(),
			messageCount: s.messageCount,
		}));
	}

	async createSession(cwd: string): Promise<AgentSnapshot> {
		assertDirectory(cwd);
		this.cwd = cwd;
		const { SessionManager } = await pi();
		const sessionManager = SessionManager.create(cwd, this.sessionDir);
		return this.startSession(sessionManager, cwd);
	}

	async openSession(req: OpenSessionRequest): Promise<AgentSnapshot> {
		assertDirectory(req.cwd);
		this.cwd = req.cwd;
		const sessionFile = this.resolveSessionFile(req.sessionFile);
		const { SessionManager } = await pi();
		const sessionManager = SessionManager.open(
			sessionFile,
			this.sessionDir,
			req.cwd,
		);
		return this.startSession(sessionManager);
	}

	/**
	 * Name a session. The open session has to be renamed through its own manager —
	 * a second manager over the same file would append behind its back, and the
	 * header it already holds in memory would go stale.
	 */
	async renameSession(req: RenameSessionRequest): Promise<void> {
		const title = normalizeLine(req.title, 80);
		if (!title) throw new Error("Session name cannot be empty");
		const sessionFile = this.resolveSessionFile(req.sessionFile);

		const active = this.session;
		if (active && active.sessionManager.getSessionFile() === sessionFile) {
			active.setSessionName(title);
		} else {
			const { SessionManager } = await pi();
			SessionManager.open(sessionFile, this.sessionDir, req.cwd).appendSessionInfo(title);
		}
		this.emitSessionsChanged();
		if (active) this.emit();
	}

	/**
	 * Delete a session's transcript. Deleting the open one closes it first, so the
	 * agent is not left holding a handle to a file that no longer exists; the
	 * renderer learns the session is gone from the cleared snapshot.
	 */
	async deleteSession(req: DeleteSessionRequest): Promise<void> {
		const sessionFile = this.resolveSessionFile(req.sessionFile);
		const closedActive = this.session?.sessionManager.getSessionFile() === sessionFile;
		if (closedActive) this.close();
		rmSync(sessionFile, { force: true });
		this.emitSessionsChanged();
		if (closedActive) this.emit();
	}

	/** Resolve a renderer-supplied path, refusing anything outside the session directory. */
	private resolveSessionFile(path: string): string {
		const sessionDir = resolve(this.sessionDir);
		const sessionFile = resolve(path);
		if (!sessionFile.startsWith(sessionDir + sep)) {
			throw new Error(`Session file outside session dir: ${path}`);
		}
		if (!existsSync(sessionFile) || !statSync(sessionFile).isFile()) {
			throw new Error(`Session file does not exist: ${path}`);
		}
		return sessionFile;
	}

	getSnapshot(): AgentSnapshot | null {
		return this.session ? this.buildSnapshot() : null;
	}

	async send(req: SendPromptRequest): Promise<SendPromptResult> {
		const session = this.session;
		if (!session) return { accepted: false, error: "No active session" };
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

		// The opening prompt becomes the session's name, which is also what makes a
		// brand-new session appear in the list — until then it has no transcript.
		const firstPrompt = !session.messages.some((m) => m.role === "user");
		if (firstPrompt) {
			session.setSessionName(normalizeLine(text, 80));
			this.emitSessionsChanged();
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

	/**
	 * Picker state for the welcome screen, where no session exists to snapshot.
	 * The model is what a new session in `cwd` would start with, so the picker
	 * never shows a selection the session would not actually use.
	 */
	async getDefaults(cwd: string): Promise<AgentDefaults> {
		assertDirectory(cwd);
		this.cwd = cwd;
		const runtime = await this.getModelRuntime();
		const { SettingsManager } = await pi();
		const { clampThinkingLevel, getSupportedThinkingLevels } = await piAi();
		const settings = SettingsManager.create(cwd);
		const model = this.resolveNewSessionModel(runtime, settings);
		const thinkingLevels = model
			? (getSupportedThinkingLevels(model) as ThinkingLevel[])
			: [...THINKING_LEVELS];
		const requested =
			this.pendingThinkingLevel ??
			(model
				? settings.getModelThinkingLevel(model.provider, model.id)
				: undefined) ??
			settings.getDefaultThinkingLevel() ??
			"medium";
		return {
			modelKey: model ? modelKeyOf(model) : null,
			models: this.modelOptions(),
			thinkingLevel: model
				? (clampThinkingLevel(model, requested) as ThinkingLevel)
				: "off",
			thinkingLevels,
			mode: this.mode,
		};
	}

	/**
	 * The model a new session in `cwd` starts with: a welcome-screen pick wins,
	 * then the saved default, then pi's per-provider preference order, then the
	 * first available model. Mirrors findInitialModel()'s non-continuing path;
	 * createAgentSession() skips its own resolution when we pass `model`.
	 */
	private resolveNewSessionModel(
		runtime: ModelRuntime,
		settings: SettingsManager,
	): Model<Api> | undefined {
		const available = runtime.getAvailableSnapshot();
		if (this.pendingModelKey) {
			const picked = available.find(
				(m) => modelKeyOf(m) === this.pendingModelKey,
			);
			if (picked) return picked;
			// Stale pick — the profile was deleted or lost auth since.
			this.pendingModelKey = null;
		}
		const defaultProvider = settings.getDefaultProvider();
		const defaultModelId = settings.getDefaultModel();
		if (defaultProvider && defaultModelId) {
			const found = runtime.getModel(defaultProvider, defaultModelId);
			if (found && runtime.hasConfiguredAuth(found.provider)) return found;
		}
		for (const [provider, id] of Object.entries(PROVIDER_DEFAULT_MODEL)) {
			const match = available.find(
				(m) => m.provider === provider && m.id === id,
			);
			if (match) return match;
		}
		return available[0];
	}

	/**
	 * The settings manager that owns default writes: the open session's when
	 * there is one (a second manager over the same files could clobber them),
	 * else a fresh one for the current directory.
	 */
	private async settingsForDefaults(): Promise<SettingsManager> {
		if (this.session) return this.session.settingsManager;
		const { SettingsManager } = await pi();
		return SettingsManager.create(this.cwd ?? app.getPath("home"));
	}

	async setModel(modelKey: string): Promise<AgentSnapshot | null> {
		const runtime = await this.getModelRuntime();
		const model = runtime
			.getAvailableSnapshot()
			.find((m) => modelKeyOf(m) === modelKey);
		if (!model) throw new Error(`Unknown model: ${modelKey}`);
		this.pendingModelKey = modelKey;
		// A pick is the user's default for future sessions too — persist it like
		// the SDK's { persist: true } does, so it survives a restart.
		(await this.settingsForDefaults()).setDefaultModelAndProvider(
			model.provider,
			model.id,
		);
		if (!this.session) {
			this.emitDefaults();
			return null;
		}
		await this.session.setModel(model);
		this.pendingError = undefined;
		const snapshot = this.buildSnapshot();
		this.emit();
		return snapshot;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<AgentSnapshot | null> {
		if (!THINKING_LEVELS.includes(level)) {
			throw new Error(`Unknown thinking level: ${level}`);
		}
		this.pendingThinkingLevel = level;
		(await this.settingsForDefaults()).setDefaultThinkingLevel(level);
		if (!this.session) {
			this.emitDefaults();
			return null;
		}
		this.session.setThinkingLevel(level);
		const snapshot = this.buildSnapshot();
		this.emit();
		return snapshot;
	}

	setMode(mode: ExecutionMode): AgentSnapshot | null {
		if (!MODES.includes(mode)) {
			throw new Error(`Unknown execution mode: ${String(mode)}`);
		}
		this.mode = mode;
		this.savePreferences();
		if (!this.session) {
			this.emitDefaults();
			return null;
		}
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
		this.wasStreaming = false;
		this.projector.reset();
		this.pendingError = undefined;
	}

	private async startSession(
		sessionManager: SessionManager,
		freshCwd?: string,
	): Promise<AgentSnapshot> {
		const generation = ++this.generation;
		// This transition owns the currently-active session; dispose it now.
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.session?.dispose();
		this.session = null;
		this.projector.reset();
		this.pendingError = undefined;

		const { createAgentSession, SettingsManager } = await pi();
		const modelRuntime = await this.getModelRuntime();
		// A brand-new session takes the welcome screen's picks; an opened one
		// keeps the model it was saved with.
		const model = freshCwd
			? this.resolveNewSessionModel(
					modelRuntime,
					SettingsManager.create(freshCwd),
				)
			: undefined;
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: sessionManager.getCwd(),
			sessionManager,
			modelRuntime,
			model,
			thinkingLevel: freshCwd
				? (this.pendingThinkingLevel ?? undefined)
				: undefined,
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
		this.wasStreaming = session.isStreaming;
		this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			this.onSessionEvent(event);
		});
		const snapshot = this.buildSnapshot();
		this.emit(snapshot);
		this.emitSessionsChanged();
		return snapshot;
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		const session = this.session;
		if (!session) return;
		this.projector.handleEvent(event as ProjectionEvent);
		this.projector.rebuild(session.messages);
		this.emit();
		// A finished run is when the row's message count and timestamp settle.
		if (this.wasStreaming && !session.isStreaming) this.emitSessionsChanged();
		this.wasStreaming = session.isStreaming;
	}

	private async handleSlash(
		command: string,
		args: string,
	): Promise<SendPromptResult | null> {
		const session = this.session;
		if (!session) return { accepted: false, error: "No active session" };
		switch (command) {
			case "help":
				this.projector.notice("info", HELP_TEXT);
				this.emit();
				return { accepted: true };
			case "new":
			case "clear":
				return { accepted: true, action: "new-session" };
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
				await this.setThinkingLevel(args as ThinkingLevel);
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
		if (!session) throw new Error("No active session");
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
		const name = sm.getSessionName();
		const model = session.model;
		return {
			session: {
				id: sm.getSessionId(),
				sessionFile,
				cwd: sm.getCwd(),
				title: sessionTitle(name, firstText),
				preview: name?.trim() ? normalizeLine(firstText, 160) : "",
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
			thinkingLevels: session.getAvailableThinkingLevels(),
			mode: this.mode,
			error: this.pendingError,
		};
	}

	/**
	 * Push the current state to the renderer, or `null` when no session is open.
	 *
	 * Not every emit comes from a session: saving a model profile refreshes the
	 * runtime and emits, and that happens from the welcome screen before there is
	 * anything to project. Reporting "no session" is the answer there — building a
	 * snapshot would throw out of whatever triggered the emit.
	 */
	private emit(snapshot?: AgentSnapshot): void {
		if (this.win.isDestroyed()) return;
		const payload = snapshot ?? (this.session ? this.buildSnapshot() : null);
		this.win.webContents.send("agent:snapshot", payload);
	}

	/**
	 * Push refreshed welcome-screen picker state. Only sent once the renderer
	 * has named a directory — before that there is no welcome screen showing.
	 */
	private emitDefaults(): void {
		if (this.win.isDestroyed() || !this.cwd) return;
		const cwd = this.cwd;
		void this.getDefaults(cwd)
			.then((defaults) => {
				if (!this.win.isDestroyed()) {
					this.win.webContents.send("agent:defaults", defaults);
				}
			})
			.catch(() => undefined);
	}

	/**
	 * Nudge the sidebar to re-read the session list. Sent on the transitions that
	 * change what a row shows — a session opening, being named, finishing a run,
	 * being renamed or deleted — rather than on every streaming event, because
	 * listing re-reads every transcript on disk.
	 */
	private emitSessionsChanged(): void {
		if (this.win.isDestroyed()) return;
		this.win.webContents.send("agent:sessionsChanged");
	}
}
