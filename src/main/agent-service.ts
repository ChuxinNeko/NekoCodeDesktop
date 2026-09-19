import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { app, type BrowserWindow } from "electron";
import type {
	AgentSession,
	AgentSessionEvent,
	LoadExtensionsResult,
	ModelRuntime,
	ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
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
import type {
	InstallPluginRequest,
	PluginActionRequest,
	PluginsSnapshot,
	SetPluginEnabledRequest,
} from "../shared/plugins";
import type {
	CheckpointFileDiff,
	CheckpointPreview,
	CheckpointSummary,
	RestoreCheckpointRequest,
	RestoreCheckpointResult,
} from "../shared/checkpoints";
import {
	CHECKPOINT_ENTRY,
	checkpointEntries,
	planReversal,
	turnStats,
	type CheckpointData,
	type ReversalPlan,
} from "./file-journal";
import { FileJournalRecorder } from "./file-journal-recorder";
import { applyReversal, fileDiffSince, previewReversal } from "./file-restore";
import { cellIdForMessage, findTurnEntry } from "./checkpoint-anchor";
import { normalizeLine, sessionTitle } from "../shared/sessions";
import type { ModelTestRequest, ModelTestResult } from "../shared/settings";
import { PluginService } from "./plugin-service";
import { BuiltinSkillStore, resolveBuiltinSkillsDir } from "./builtin-skills";
import type { SetSkillEnabledRequest, SkillOrigin, SkillSummary, SkillsSnapshot } from "../shared/skills";
import { CellProjector, expandNekoSlashAlias, parseSlashCommand, type ProjectionEvent } from "./agent-projection";
import type { ModelConfigService } from "./model-config-service";
import { decideModelAfterReload } from "./model-refresh";
import { registerOAuthClientIdentity } from "./oauth-service";
import type { AntigravityOAuthService } from "./antigravity-oauth-service";
import { registerAntigravityProvider } from "./antigravity-provider";
import { pi, piAi } from "./pi";
import { buildTitleRequest, sanitizeGeneratedTitle, TITLE_TIMEOUT_MS } from "./session-title";
import {
	DEFAULT_AGENT_PHASE,
	isWorkMode,
	type WorkMode,
	type WorkflowAnswer,
} from "../shared/workflow";
import { createWorkflowSession, type WorkflowRuntime } from "./workflow-runtime";
import type { BrowserInspector } from "./browser-inspector";
import {
	createWebsiteCloneTools,
	resolveWebsiteCloneTemplateDir,
	WEBSITE_CLONE_TOOL_NAMES,
} from "./website-clone-tools";
import { isFusionConfig, type FusionConfig } from "../shared/fusion";
import { resolveFusion } from "./fusion-config";
import { withFusionUsage } from "./fusion-usage";
import { BrowserPreview } from "./browser-preview";

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
	"/design [brief] — create a design artifact in the current workspace",
	"/clone-website <url...> — clone websites with native browser inspection",
	"/new, /clear — start a new session",
	"/abort — stop the current run",
	"/compact [focus] — compact context",
	"/mode <agent|ask|plan|debug|multitask> — change work mode",
	"/commit-message [instructions] — propose a message for staged changes (no commit)",
	"/model [provider/id] — list or select a model",
	"/thinking <level> — set thinking level",
	"/terminal — open the terminal drawer",
].join("\n");

const NO_MODEL_ERROR =
	"No model configured. Add credentials to ~/.nekocode/agent/auth.json or set a provider API key environment variable, then restart.";

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

/** The transcript line a finished restore leaves behind. */
function describeRestore(outcome: {
	scope: RestoreCheckpointRequest["scope"];
	label: string;
	restored: number;
	deleted: number;
	conversationRewound: boolean;
}): string {
	const parts: string[] = [];
	if (outcome.scope !== "conversation") {
		parts.push(
			outcome.restored || outcome.deleted
				? `恢复 ${outcome.restored} 个文件，删除 ${outcome.deleted} 个新增文件`
				: "代码无需改动",
		);
	}
	if (outcome.scope !== "code") {
		parts.push(outcome.conversationRewound ? "对话已回退到这一轮之前" : "对话未回退");
	}
	return `已回退到检查点「${outcome.label}」：${parts.join("；")}`;
}

/** What an assistant message said, with thinking and tool calls left out. */
function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
}

export class AgentService {
	private session: AgentSession | null = null;
	private unsubscribe: (() => void) | null = null;
	private projector = new CellProjector();
	private mode: ExecutionMode = "auto";
	private workMode: WorkMode = "agent";
	private workflow: WorkflowRuntime | null = null;
	private helperAbort: AbortController | null = null;
	/**
	 * The in-flight title generation, and the session file it names. Kept apart
	 * from `helperAbort` because naming a session must never gate the composer:
	 * it runs alongside the very prompt that triggered it.
	 */
	private titleAbort: AbortController | null = null;
	private titlePendingFile: string | null = null;
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
	private pendingFusion: FusionConfig | null = null;
	private preview: BrowserPreview | null = null;
	private supportedThinking: typeof import("@earendil-works/pi-ai").getSupportedThinkingLevels | undefined;
	private pendingThinkingLevel: ThinkingLevel | null = null;
	/** Last directory the renderer asked about — where pushed defaults apply. */
	private cwd: string | null = null;
	private readonly preferencesPath: string;
	readonly plugins: PluginService;
	/** The skills that ship with the app, and which of them are switched on. */
	readonly builtinSkills: BuiltinSkillStore;
	/** Records pre-images for the open session's file-changing tool calls. */
	private journal: FileJournalRecorder | null = null;
	/** What the open session's extensions registered; replaced on every reload. */
	private extensions: LoadExtensionsResult | undefined;
	private resourceLoader: ResourceLoader | undefined;

	constructor(
		private readonly win: BrowserWindow,
		private readonly modelConfig: ModelConfigService,
		private readonly browserInspector: BrowserInspector,
		private readonly antigravity?: AntigravityOAuthService,
	) {
		this.sessionDir = join(app.getPath("userData"), "sessions");
		mkdirSync(this.sessionDir, { recursive: true });
		this.preferencesPath = join(app.getPath("userData"), "preferences.json");
		this.plugins = new PluginService({
			statePath: join(app.getPath("userData"), "plugins.json"),
			onChange: () => this.emitPlugins(),
		});
		this.builtinSkills = new BuiltinSkillStore(
			resolveBuiltinSkillsDir({
				appPath: app.getAppPath(),
				resourcesPath: process.resourcesPath,
				override: process.env.NEKOCODE_BUILTIN_SKILLS,
			}),
			join(app.getPath("userData"), "builtin-skills.json"),
		);
		this.loadPreferences();
	}

	/** Tool names the enabled plugins contribute to the open session. */
	private pluginTools(): string[] {
		return this.plugins.enabledTools(this.extensions);
	}

	private emitPlugins(): void {
		void this.pluginsSnapshot()
			.then((snapshot) => this.win.webContents.send("plugins:changed", snapshot))
			.catch(() => undefined);
	}

	pluginsSnapshot(): Promise<PluginsSnapshot> {
		return this.plugins.list(this.cwd, this.extensions);
	}

	/**
	 * Apply a plugin change to the running session without restarting it.
	 *
	 * `AgentSession.reload()` shuts the old extension runtime down, reloads
	 * settings and resources, and rebuilds the tool set — so a package installed
	 * a second ago is live. The workflow's own gate is refreshed afterwards
	 * because the newly registered tools are not in any mode manifest and only
	 * pass by way of the plugin list.
	 */
	private async reloadPlugins(): Promise<void> {
		const session = this.session;
		if (!session) {
			this.emitPlugins();
			return;
		}
		await session.reload();
		this.extensions = this.resourceLoader?.getExtensions();
		this.workflow?.refresh();
		this.emitPlugins();
		this.emit();
	}

	async installPlugin(request: InstallPluginRequest): Promise<PluginsSnapshot> {
		if (!this.cwd) throw new Error("请先打开一个项目");
		await this.plugins.install(this.cwd, request);
		await this.reloadPlugins();
		return this.pluginsSnapshot();
	}

	async removePlugin(request: PluginActionRequest): Promise<PluginsSnapshot> {
		if (!this.cwd) throw new Error("请先打开一个项目");
		await this.plugins.remove(this.cwd, request);
		await this.reloadPlugins();
		return this.pluginsSnapshot();
	}

	async updatePlugin(source?: string): Promise<PluginsSnapshot> {
		if (!this.cwd) throw new Error("请先打开一个项目");
		await this.plugins.update(this.cwd, source);
		await this.reloadPlugins();
		return this.pluginsSnapshot();
	}

	/**
	 * Enabling changes no files, so no reload is needed — the gate reads the
	 * plugin list on every tool call. The tool list the model sees does have to
	 * be refreshed, or it would not know the tools appeared.
	 */
	async setPluginEnabled(request: SetPluginEnabledRequest): Promise<PluginsSnapshot> {
		this.plugins.setEnabled(request);
		this.workflow?.refresh();
		this.emit();
		return this.pluginsSnapshot();
	}

	/**
	 * The skills the settings page lists: the ones that ship with the app, and
	 * the ones the open session actually loaded.
	 *
	 * The two lists answer different questions. The first is what can be switched
	 * on and off here; the second is what the model was told about this session,
	 * which also covers skills the user dropped in themselves and ones a package
	 * brought along — those are not this app's to disable, but hiding them would
	 * make the prompt look emptier than it is.
	 */
	async skillsSnapshot(): Promise<SkillsSnapshot> {
		const { getAgentDir, getProjectConfigDir } = await pi();
		const loaded = this.resourceLoader?.getSkills();
		const origin = (skill: { filePath: string; sourceInfo?: { scope?: string; origin?: string } }): SkillOrigin => {
			if (this.builtinSkills.isBuiltin(skill.filePath)) return "builtin";
			if (skill.sourceInfo?.origin === "package") return "package";
			return skill.sourceInfo?.scope === "project" ? "project" : "user";
		};
		const active: SkillSummary[] = (loaded?.skills ?? []).map((skill) => ({
			name: skill.name,
			description: skill.description,
			path: skill.filePath,
			origin: origin(skill),
			// Loaded is enabled: a skill switched off never reaches this list.
			enabled: true,
		}));
		return {
			builtin: this.builtinSkills.list(),
			active,
			directories: {
				user: join(getAgentDir(), "skills"),
				project: this.cwd ? join(getProjectConfigDir(this.cwd), "skills") : null,
			},
			// Every diagnostic the loader emits is a problem — a bad frontmatter, a
			// path that vanished, two skills claiming one name.
			warnings: (loaded?.diagnostics ?? []).map(
				(diagnostic) => `${diagnostic.message} — ${diagnostic.path}`,
			),
		};
	}

	/**
	 * Switch a built-in skill on or off.
	 *
	 * A skill is nothing but a name and a description in the system prompt until
	 * the model reads its file, so rebuilding that prompt *is* the change:
	 * `reload()` re-runs the resource load, and the filter the loader was built
	 * with reads the new state. Without a session there is nothing to rebuild and
	 * the next one will pick it up.
	 */
	async setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillsSnapshot> {
		this.builtinSkills.setEnabled(request.name, request.enabled);
		const session = this.session;
		if (session) {
			await session.reload();
			this.extensions = this.resourceLoader?.getExtensions();
			this.workflow?.refresh();
			this.emit();
		}
		return this.skillsSnapshot();
	}

	/**
	 * App-level preferences for execution permission and the next session's work
	 * mode. Missing or corrupt files retain the auto / Agent defaults.
	 */
	private loadPreferences(): void {
		try {
			const raw: unknown = JSON.parse(readFileSync(this.preferencesPath, "utf8"));
			const workMode = (raw as { workMode?: unknown }).workMode;
			const fusion = (raw as { fusion?: unknown }).fusion;
			if (isFusionConfig(fusion)) this.pendingFusion = fusion;
			if (isWorkMode(workMode)) this.workMode = workMode;
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
			writeFileSync(
				this.preferencesPath,
				`${JSON.stringify({ mode: this.mode, workMode: this.workMode, fusion: this.pendingFusion })}\n`,
			);
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
				.then(async (runtime) => {
					this.supportedThinking = (await piAi()).getSupportedThinkingLevels;
					this.runtime = runtime;
					// Before anything can be sent: a subscription provider that goes
					// out under the wrong client identity is the request that gets an
					// account flagged.
					registerOAuthClientIdentity(runtime);
					if (this.antigravity) await registerAntigravityProvider(runtime, this.antigravity);
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
				authHeader: profile.api === "openai-completions" || profile.api === "openai-responses",
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
		await this.runtime?.refresh({ allowNetwork: false });
		if (session && this.runtime) {
			const runtime = this.runtime;
			const firstCustom =
				runtime
					.getAvailableSnapshot()
					.filter((m) => this.customProviderIds.has(m.provider))
					.map((m) => ({ provider: m.provider, id: m.id }))[0] ?? null;
			const decision = decideModelAfterReload({
				current: current ? { provider: current.provider, id: current.id } : null,
				isRegistered: (p, id) => runtime.getModel(p, id) !== undefined,
				firstCustom,
			});
			if (decision.kind === "set") {
				try {
					const refreshed = runtime.getModel(decision.model.provider, decision.model.id);
					if (refreshed) {
						await session.setModel(refreshed);
						this.pendingError = undefined;
					} else {
						this.pendingError = `模型配置刷新失败: 模型 ${decision.model.provider}/${decision.model.id} 未注册`;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.pendingError = `模型配置刷新失败: ${message}`.slice(0, 500);
				}
			} else if (decision.kind === "removed") {
				this.pendingError = "当前模型配置已被移除，请添加或选择可用模型";
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
			const model = runtime.getModel(req.profileId === "antigravity" ? "antigravity" : `nekocode-${req.profileId}`, req.modelId);
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
				const message = await runtime.completeSimple(
					model,
					{
						messages: [
							{
								role: "user",
								content: "Reply with exactly OK.",
								timestamp: Date.now(),
							},
						],
					},
					{ maxTokens: req.profileId === "antigravity" ? 2048 : 8, signal: controller.signal },
				);
				const text = assistantText(message);
				const ok =
					message.stopReason !== "error" && message.stopReason !== "aborted" && text.length > 0;
				return {
					ok,
					latencyMs: Date.now() - start,
					message: ok
						? "成功"
						: req.profileId === "antigravity" ? (message.errorMessage ?? `stopReason: ${message.stopReason}`) : (message.errorMessage ?? `stopReason: ${message.stopReason}`).slice(0, 500),
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
				message: req.profileId === "antigravity" ? raw : raw.slice(0, 500),
			};
		}
	}

	async listSessions(cwd?: string): Promise<SessionSummary[]> {
		if (cwd) assertDirectory(cwd);
		const { SessionManager } = await pi();
		const sessions = cwd ? await SessionManager.list(cwd, this.sessionDir) : await SessionManager.listAll(this.sessionDir);
		return sessions.map((s) => ({
			id: s.id,
			sessionFile: s.path,
			cwd: s.cwd || cwd || "",
			title: sessionTitle(s.name, s.firstMessage),
			titlePending: this.isTitlePending(s.path),
			// Only named sessions get a second line: for the rest the title
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
		// Re-opening the session that is already open would reload it from disk,
		// which for one still waiting on its first assistant message means reading
		// a file that is not there yet and starting over empty.
		if (this.session?.sessionManager.getSessionFile() === sessionFile) {
			return this.buildSnapshot();
		}
		const { SessionManager } = await pi();
		const sessionManager = SessionManager.open(sessionFile, this.sessionDir, req.cwd);
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

		// An explicit name settles the question — drop a title still in flight.
		if (this.isTitlePending(sessionFile)) this.cancelTitleGeneration();

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

	/** Is this the session whose model-written title has not come back yet? */
	private isTitlePending(sessionFile: string): boolean {
		return this.titlePendingFile !== null && resolve(sessionFile) === this.titlePendingFile;
	}

	private cancelTitleGeneration(): void {
		this.titleAbort?.abort();
		this.titleAbort = null;
		this.titlePendingFile = null;
	}

	/**
	 * Name a session after its opening prompt, using the session's own model.
	 *
	 * Fire-and-forget, and deliberately not routed through `helperAbort`: the run
	 * this prompt started is already going, and the composer must not wait on a
	 * title. A title that never arrives is not an error either — the row keeps
	 * falling back to the opening prompt, which is what it used to show.
	 */
	private startTitleGeneration(session: AgentSession, firstPrompt: string): void {
		const fusion = this.workflow?.fusion;
		const model = fusion
			? this.runtime?.getAvailableSnapshot().find((m) => modelKeyOf(m) === fusion.sidekickModelKey)
			: session.model;
		const runtime = this.runtime;
		const sessionFile = session.sessionManager.getSessionFile();
		if (!model || !runtime || !sessionFile) return;
		this.cancelTitleGeneration();
		const controller = new AbortController();
		this.titleAbort = controller;
		this.titlePendingFile = resolve(sessionFile);
		const generation = this.generation;
		const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
		this.emit();
		this.emitSessionsChanged();

		void (async () => {
			try {
				const request = buildTitleRequest(firstPrompt, { modelMaxTokens: model.maxTokens });
				const message = await runtime.completeSimple(
					model,
					{ systemPrompt: request.systemPrompt, messages: request.messages },
					{ maxTokens: request.maxTokens, signal: controller.signal },
				);
				const title = sanitizeGeneratedTitle(assistantText(message));
				if (!title || controller.signal.aborted || generation !== this.generation) return;
				const active = this.session;
				if (!active || !this.isTitlePending(active.sessionManager.getSessionFile() ?? "")) return;
				// A rename landing first wins: it is the one the user chose.
				if (active.sessionManager.getSessionName()) return;
				active.setSessionName(title);
			} catch {
				// Offline, no credentials, a refused request — the fallback stands.
			} finally {
				clearTimeout(timer);
				// A newer session (or a rename) already took this over; leave its state alone.
				if (this.titleAbort === controller) {
					this.titleAbort = null;
					this.titlePendingFile = null;
					this.emit();
					this.emitSessionsChanged();
				}
			}
		})();
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
		// Checkpoints live in the transcript, so they go with it. Nothing to clean
		// up elsewhere: there is no elsewhere.
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
		// The open session is real even before its file is: a transcript is only
		// written once the first assistant message lands, and the sidebar lists
		// the session from the moment its first prompt is sent.
		if (this.session?.sessionManager.getSessionFile() === sessionFile) return sessionFile;
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
		const text = expandNekoSlashAlias(req.text);
		if (!text.trim()) return { accepted: false, error: "Empty message" };
		const slash = parseSlashCommand(text);
		if (slash?.command === "abort") {
			await this.abort();
			return { accepted: true };
		}
		if (this.workflow?.state.hasPendingQuestion)
			return { accepted: false, error: "请先回答或取消当前问题" };
		if (this.helperAbort) return { accepted: false, error: "请等待提交信息生成，或先停止当前运行" };
		this.workflow?.refresh();
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
		if (this.workflow?.fusion) {
			try {
				const { config } = await resolveFusion(this.workflow.fusion, await this.getModelRuntime());
				if (modelKeyOf(session.model) !== config.leadModelKey)
					throw new Error("Fusion Lead 模型已变化，请重新应用 Fusion 配置");
			}
			catch (error) { return { accepted: false, error: String(error) }; }
		}

		// The opening prompt is what the session gets named after — by the model,
		// in the background. Until that lands the row shows a placeholder.
		const firstPrompt = !session.messages.some((m) => m.role === "user");
		if (firstPrompt) this.startTitleGeneration(session, text);

		// Before the agent can touch anything, so everything the turn changes is
		// recorded after the marker. Steering joins the turn already running, and
		// that turn has a marker already.
		if (!session.isStreaming) this.markCheckpoint(session, text);

		try {
			if (session.isStreaming) {
				await session.prompt(text, { streamingBehavior: "steer" });
			} else {
				session.prompt(text).catch((error: unknown) => {
					this.projector.notice("error", error instanceof Error ? error.message : String(error));
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
		this.helperAbort?.abort();
		this.workflow?.stop();
		await this.session?.abort();
		await this.workflow?.state.whenSettled();
		this.emit();
	}

	// =========================================================================
	// Checkpoints
	// =========================================================================

	/**
	 * Mark the point a turn starts from.
	 *
	 * A marker entry in the session tree, nothing more: what the turn goes on to
	 * change is recorded beside it by the journal as each tool runs. There is no
	 * work to do here and nothing to copy, which is the whole reason this can run
	 * in front of every prompt without anyone noticing.
	 */
	private markCheckpoint(session: AgentSession, prompt: string): void {
		try {
			const data: CheckpointData = { label: normalizeLine(prompt, 120) };
			session.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY, data);
			this.emit();
		} catch (error) {
			// Never block a prompt on the safety net failing to deploy.
			console.error("Could not mark a checkpoint:", error);
		}
	}

	/**
	 * Every checkpoint for the open session, newest first.
	 *
	 * Read straight off the session tree, so there is no index to keep in step
	 * and nothing to invalidate: a checkpoint that is on the active branch is one
	 * you can go back to, and one that is not, is not. The branch is walked once
	 * for all of them rather than once each.
	 */
	listCheckpoints(): CheckpointSummary[] {
		const session = this.session;
		if (!session) return [];
		const sessionId = session.sessionManager.getSessionId();
		const branch = session.sessionManager.getBranch();
		const messages = session.messages;
		const summaries = checkpointEntries(branch).map((marker) => {
			const turn = findTurnEntry(branch, marker.id);
			const plan = planReversal(branch, marker.id);
			const stats = turnStats(branch, marker.id);
			return {
				id: marker.id,
				sessionId,
				createdAt: marker.timestamp,
				label: marker.label,
				cellId: cellIdForMessage(messages, turn?.message ?? undefined),
				conversationRestorable: turn !== null,
				codeRestorable: plan.steps.length > 0,
				fileCount: stats.files,
				files: stats.list,
				additions: stats.additions,
				deletions: stats.deletions,
				shellRuns: plan.opaqueRuns,
			} satisfies CheckpointSummary;
		});
		return summaries.reverse();
	}

	/** The reversal plan for one checkpoint, or null when it is off the branch. */
	private reversalFor(id: string): { plan: ReversalPlan; label: string } | null {
		const session = this.session;
		if (!session) return null;
		const branch = session.sessionManager.getBranch();
		const marker = checkpointEntries(branch).find((entry) => entry.id === id);
		if (!marker) return null;
		return { plan: planReversal(branch, id), label: marker.label };
	}

	/**
	 * One file's changes since a checkpoint, as a patch.
	 *
	 * Computed on demand rather than carried on every snapshot: a patch is the
	 * thing you open one of at a time, and putting all of them on the snapshot
	 * would send the contents of every changed file to the renderer on every
	 * streaming event.
	 */
	async checkpointFileDiff(id: string, path: string): Promise<CheckpointFileDiff> {
		const session = this.session;
		if (!session) throw new Error("没有打开的会话");
		const found = this.reversalFor(id);
		const step = found?.plan.steps.find((candidate) => candidate.path === path);
		if (!step) throw new Error("该检查点没有记录这个文件的改动");
		return fileDiffSince(step, session.sessionManager.getCwd());
	}

	/** What restoring this checkpoint's code would change, for the confirmation. */
	async previewCheckpoint(id: string): Promise<CheckpointPreview> {
		const session = this.session;
		if (!session) throw new Error("没有打开的会话");
		const found = this.reversalFor(id);
		const checkpoint = this.listCheckpoints().find((summary) => summary.id === id);
		if (!found || !checkpoint) throw new Error("检查点不存在或已不在当前对话分支上");
		return { checkpoint, diff: await previewReversal(found.plan, session.sessionManager.getCwd()) };
	}

	/**
	 * Put the project back to a checkpoint.
	 *
	 * Refuses while anything is running: rewinding the session tree under a live
	 * turn would leave the agent appending to a branch that no longer exists, and
	 * restoring files under a running tool would race its writes. The caller has
	 * already confirmed with the user by the time this is reached — the guard
	 * here is about the machine's state, not the user's intent.
	 */
	async restoreCheckpoint(request: RestoreCheckpointRequest): Promise<RestoreCheckpointResult> {
		const session = this.session;
		if (!session) throw new Error("没有打开的会话");
		if (
			session.isStreaming ||
			session.isCompacting ||
			this.helperAbort ||
			this.workflow?.state.hasRunningTasks
		) {
			throw new Error("请先停止当前运行及后台任务，再回退到检查点");
		}
		const found = this.reversalFor(request.id);
		if (!found) throw new Error("检查点不存在或已不在当前对话分支上");
		const warnings: string[] = [];
		let restored = 0;
		let deleted = 0;
		let conversationRewound = false;
		let editorText: string | undefined;

		// Files first, and from the plan read before anything moved: rewinding the
		// tree first would take the very entries the plan is built from off the
		// active branch, leaving nothing to put back.
		if (request.scope === "code" || request.scope === "both") {
			const result = await applyReversal(found.plan, session.sessionManager.getCwd());
			restored = result.restored;
			deleted = result.deleted;
			warnings.push(...result.warnings);
		}

		if (request.scope === "conversation" || request.scope === "both") {
			const entry = findTurnEntry(session.sessionManager.getBranch(), request.id);
			if (!entry) {
				warnings.push("这个检查点后面没有可回退的对话");
			} else {
				const result = await session.navigateTree(entry.id);
				if (result.cancelled) {
					warnings.push("对话回退被取消");
				} else {
					conversationRewound = true;
					editorText = result.editorText ?? found.label;
				}
			}
		}

		if (conversationRewound) {
			// Reset, not just rebuild: the overlay still holds the live cells of the
			// turn that was just undone, and they have no persisted message left to
			// be reconciled against.
			this.projector.reset();
			this.projector.rebuild(session.messages, session.isStreaming);
			this.emitSessionsChanged();
		}
		this.projector.notice(
			warnings.length ? "warning" : "info",
			describeRestore({ scope: request.scope, label: found.label, restored, deleted, conversationRewound }),
		);
		this.emit();
		return { restored, deleted, conversationRewound, editorText, warnings };
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
			(model ? settings.getModelThinkingLevel(model.provider, model.id) : undefined) ??
			settings.getDefaultThinkingLevel() ??
			"medium";
		return {
			modelKey: model ? modelKeyOf(model) : null,
			fusion: this.pendingFusion,
			models: this.modelOptions(),
			thinkingLevel: model ? (clampThinkingLevel(model, requested) as ThinkingLevel) : "off",
			thinkingLevels,
			mode: this.mode,
			workMode: this.workMode,
			// No session, so no run to have matched a phase to yet.
			agentPhase: DEFAULT_AGENT_PHASE,
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
		if (this.pendingFusion) {
			const lead = available.find((m) => modelKeyOf(m) === this.pendingFusion!.leadModelKey);
			if (lead) return lead;
		}
		if (this.pendingModelKey) {
			const picked = available.find((m) => modelKeyOf(m) === this.pendingModelKey);
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
			const match = available.find((m) => m.provider === provider && m.id === id);
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
		this.assertWorkflowIdle();
		const runtime = await this.getModelRuntime();
		const model = runtime.getAvailableSnapshot().find((m) => modelKeyOf(m) === modelKey);
		if (!model) throw new Error(`Unknown model: ${modelKey}`);
		await this.workflow?.setFusion(null);
		this.pendingFusion = null;
		this.savePreferences();
		this.pendingModelKey = modelKey;
		// A pick is the user's default for future sessions too — persist it like
		// the SDK's { persist: true } does, so it survives a restart.
		(await this.settingsForDefaults()).setDefaultModelAndProvider(model.provider, model.id);
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
		this.assertWorkflowIdle();
		const fusion = this.session ? this.workflow?.fusion : this.pendingFusion;
		if (fusion) return this.setFusion({ ...fusion, leadThinkingLevel: level });
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
		this.assertWorkflowIdle();
		this.mode = mode;
		this.savePreferences();
		if (!this.session) {
			this.emitDefaults();
			return null;
		}
		this.workflow?.refresh();
		const snapshot = this.buildSnapshot();
		this.emit();
		return snapshot;
	}

	async setFusion(value: FusionConfig): Promise<AgentSnapshot | null> {
		this.assertWorkflowIdle();
		const { config } = await resolveFusion(value, await this.getModelRuntime());
		await this.workflow?.setFusion(config);
		this.pendingFusion = config;
		this.pendingModelKey = config.leadModelKey;
		this.pendingThinkingLevel = config.leadThinkingLevel;
		this.savePreferences();
		if (!this.session) { this.emitDefaults(); return null; }
		this.pendingError = undefined;
		this.emit();
		return this.buildSnapshot();
	}

	private assertWorkflowIdle(): void {
		if (
			this.session?.isStreaming ||
			this.session?.isCompacting ||
			this.helperAbort ||
			this.workflow?.state.hasRunningTasks
		)
			throw new Error("请先停止当前运行及后台任务，再切换模式或权限");
	}

	setWorkMode(mode: WorkMode): AgentSnapshot | null {
		if (!isWorkMode(mode)) throw new Error("Unknown work mode");
		this.assertWorkflowIdle();
		this.workMode = mode;
		this.savePreferences();
		this.workflow?.setMode(mode);
		if (!this.session) {
			this.emitDefaults();
			return null;
		}
		const snapshot = this.buildSnapshot();
		this.emit(snapshot);
		return snapshot;
	}

	answerWorkflow(answer: WorkflowAnswer): AgentSnapshot {
		if (!this.workflow) throw new Error("No active workflow");
		this.workflow.answer(answer);
		return this.buildSnapshot();
	}

	cancelTask(id: string): AgentSnapshot {
		if (!this.workflow) throw new Error("No active workflow");
		this.workflow.cancelTask(id);
		return this.buildSnapshot();
	}

	close(): void {
		this.preview?.dispose();
		this.preview = null;
		this.generation++;
		this.helperAbort?.abort();
		this.helperAbort = null;
		this.cancelTitleGeneration();
		this.workflow?.dispose();
		this.workflow = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.session?.dispose();
		this.session = null;
		this.wasStreaming = false;
		this.projector.reset();
		this.pendingError = undefined;
		this.journal?.reset();
		this.journal = null;
	}

	private async startSession(
		sessionManager: SessionManager,
		freshCwd?: string,
	): Promise<AgentSnapshot> {
		this.preview?.dispose();
		const preview = new BrowserPreview({
			cwd: sessionManager.getCwd(), sessionId: sessionManager.getSessionId(),
			onPreview: (request) => {
				if (this.preview === preview && !this.win.isDestroyed())
					this.win.webContents.send("browser:preview", request);
			},
		});
		this.preview = preview;
		const generation = ++this.generation;
		this.helperAbort?.abort();
		this.helperAbort = null;
		this.cancelTitleGeneration();
		const previousWorkflow = this.workflow;
		previousWorkflow?.dispose();
		this.workflow = null;
		// This transition owns the currently-active session; dispose it now.
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.session?.dispose();
		this.session = null;
		this.projector.reset();
		this.pendingError = undefined;
		this.journal?.reset();
		this.journal = null;

		await previousWorkflow?.state.whenSettled();
		if (generation !== this.generation) throw new Error("Session superseded");
		const { SettingsManager } = await pi();
		const modelRuntime = await this.getModelRuntime();
		const cloneTools = createWebsiteCloneTools({
			cwd: sessionManager.getCwd(),
			browser: this.browserInspector,
			templateDir: resolveWebsiteCloneTemplateDir({
				appPath: app.getAppPath(),
				resourcesPath: process.resourcesPath,
				override: process.env.NEKOCODE_WEBSITE_CLONER_TEMPLATE,
			}),
			onNavigate: (request) => {
				if (!this.win.isDestroyed()) {
					this.win.webContents.send("browser:preview", {
						...request,
						sessionId: sessionManager.getSessionId(),
						cwd: sessionManager.getCwd(),
					});
				}
			},
		});
		// A brand-new session takes the welcome screen's picks; an opened one
		// keeps the model it was saved with.
		const model = freshCwd
			? this.resolveNewSessionModel(modelRuntime, SettingsManager.create(freshCwd))
			: undefined;
		const {
			session,
			workflow,
			modelFallbackMessage,
			extensionsResult,
			resourceLoader,
			fusionError,
		} = await createWorkflowSession({
			initialFusion: freshCwd ? this.pendingFusion : undefined,
			onHelperEvent: (event, source) => preview.handle(event, source),
			cwd: sessionManager.getCwd(),
			sessionManager,
			initialMode: this.workMode,
			getPermission: () => this.mode,
			debugRoot: join(app.getPath("userData"), "debug-logs"),
			onChange: () => {
				if (generation === this.generation && this.session) this.emit();
			},
			onError: (message) => {
				if (generation === this.generation) this.projector.notice("error", message);
			},
			onModeChange: (mode) => {
				if (generation === this.generation) {
					this.workMode = mode;
					this.savePreferences();
				}
			},
			getPluginTools: () => [...new Set([...this.pluginTools(), ...WEBSITE_CLONE_TOOL_NAMES])],
			builtinSkills: this.builtinSkills,
			customTools: cloneTools,
			modelRuntime,
			model,
			thinkingLevel: freshCwd ? (this.pendingThinkingLevel ?? undefined) : undefined,
		});
		if (generation !== this.generation) {
			workflow.dispose();
			session.dispose();
			throw new Error("Session superseded");
		}
		this.runtime = modelRuntime;
		this.session = session;
		this.workflow = workflow;
		this.extensions = extensionsResult;
		this.resourceLoader = resourceLoader;
		this.workMode = workflow.workMode;
		this.createdAt = Date.now();
		workflow.refresh();
		if (!session.model || session.model.provider === "unknown") {
			this.pendingError = modelFallbackMessage ?? NO_MODEL_ERROR;
		} else if (modelFallbackMessage) {
			this.projector.notice("warning", modelFallbackMessage);
		}
		if (fusionError) this.pendingError = fusionError;
		this.projector.rebuild(session.messages, session.isStreaming);
		this.wasStreaming = session.isStreaming;
		// After the workflow gate, so a tool it blocks is never recorded as having
		// changed anything. Nothing is scanned or copied here — the recorder only
		// wakes up when a tool call names a file.
		this.journal = new FileJournalRecorder(sessionManager.getCwd());
		this.journal.attach(session);
		this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			this.onSessionEvent(event);
		});
		const snapshot = this.buildSnapshot();
		this.emit(snapshot);
		this.emitSessionsChanged();
		this.emitPlugins();
		return snapshot;
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		const session = this.session;
		if (!session) return;
		this.preview?.handle(event as ProjectionEvent);
		this.projector.handleEvent(event as ProjectionEvent);
		this.projector.rebuild(session.messages, session.isStreaming);
		this.emit();
		// A finished run is when the row's message count and timestamp settle.
		if (this.wasStreaming && !session.isStreaming) this.emitSessionsChanged();
		this.wasStreaming = session.isStreaming;
	}

	private async handleSlash(command: string, args: string): Promise<SendPromptResult | null> {
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
				await this.abort();
				this.emit();
				return { accepted: true };
			case "compact":
				if (this.workflow?.state.hasRunningTasks)
					return { accepted: false, error: "请先等待或停止后台任务" };
				session.compact(args || undefined).catch((error: unknown) => {
					this.projector.notice("error", error instanceof Error ? error.message : String(error));
					this.emit();
				});
				return { accepted: true };
			case "mode": {
				if (!isWorkMode(args))
					return { accepted: false, error: "Modes: agent, ask, plan, debug, multitask" };
				try {
					this.setWorkMode(args);
					return { accepted: true };
				} catch (error) {
					return { accepted: false, error: String(error) };
				}
			}
			case "commit-message": {
				if (!this.workflow || session.isStreaming || this.workflow.state.hasRunningTasks)
					return { accepted: false, error: "请先等待当前运行结束" };
				const controller = new AbortController();
				const generation = this.generation;
				this.helperAbort = controller;
				this.emit();
				void this.workflow
					.commitMessage(args, controller.signal)
					.then(async (text) => {
						if (!controller.signal.aborted && generation === this.generation)
							await session.sendCustomMessage({
								customType: "nekocode.commit-message",
								content: "建议提交信息（未创建提交）：\n\n" + text,
								display: true,
								details: {},
							});
					})
					.catch((error: unknown) => {
						if (!controller.signal.aborted && generation === this.generation)
							this.projector.notice("error", String(error));
					})
					.finally(() => {
						if (this.helperAbort === controller) {
							this.helperAbort = null;
							this.emit();
						}
					});
				return { accepted: true };
			}
			case "model": {
				if (!args) {
					const models = this.modelOptions();
					this.projector.notice(
						"info",
						models.length ? models.map((m) => m.key).join("\n") : "No models available",
					);
					this.emit();
					return { accepted: true };
				}
				try {
					await this.setModel(args);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
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
		const runtime = this.runtime;
		if (!runtime) return [];
		return runtime.getAvailableSnapshot().map((m) => ({
			key: modelKeyOf(m),
			provider: m.provider,
			// The registered provider's label: what the user named the endpoint in
			// settings, rather than the `nekocode-<uuid>` it is keyed by.
			providerName: runtime.getProvider(m.provider)?.name ?? m.provider,
			id: m.id,
			name: m.name,
			thinkingLevels: this.supportedThinking?.(m) ?? ["off"],
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
		const firstText = firstUser && typeof firstUser.content === "string" ? firstUser.content : "";
		const name = sm.getSessionName();
		const model = session.model;
		return {
			session: {
				id: sm.getSessionId(),
				sessionFile,
				cwd: sm.getCwd(),
				title: sessionTitle(name, firstText),
				titlePending: this.isTitlePending(sessionFile),
				preview: name?.trim() ? normalizeLine(firstText, 160) : "",
				createdAt,
				updatedAt: Date.now(),
				messageCount: messages.length,
			},
			cells: withFusionUsage(this.projector.cells(), sm.getBranch(), this.workflow?.state.hasRunningTasks),
			checkpoints: this.listCheckpoints(),
			fusion: this.workflow?.fusion ?? null,
			workflow: this.workflow?.state.snapshot() ?? { request: null, todos: [], tasks: [] },
			streaming: session.isStreaming || this.helperAbort !== null,
			modelKey:
				model && model.provider !== "unknown" && this.isModelUsable(model)
					? modelKeyOf(model)
					: null,
			models: this.modelOptions(),
			thinkingLevel: session.thinkingLevel,
			thinkingLevels: session.getAvailableThinkingLevels(),
			mode: this.mode,
			workMode: this.workMode,
			agentPhase: this.workflow?.agentPhase ?? DEFAULT_AGENT_PHASE,
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
