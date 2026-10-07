import { TaskManager } from "./task-manager";
import { TaskNotifier } from "./task-notifier";
import { AppPreferencesStore } from "./app-preferences";
import { ModelPricingService } from "./model-pricing";
import { WorktreeService, type PreparedWorkspace } from "./worktree-service";
import { McpService } from "./mcp/service";
import { McpAuthStore } from "./mcp/oauth";
import { AcpService } from "./acp/service";
import { AcpConfigStore } from "./acp/config-store";
import type { AcpToolServers } from "./acp/session";
import { McpToolServer } from "./mcp/tool-server";
import { createWebsiteCloneTools, resolveWebsiteCloneTemplateDir } from "./website-clone-tools";
import { devServers } from "./website-clone-dev-server";
import { pi, piAi } from "./pi";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ComputerUseService } from "./computer/service";
import { CursorOverlay } from "./computer/cursor-overlay";
import { QqBotService } from "./qqbot/service";
import { renderBlock } from "./qqbot/code-image";
import { LanService } from "./lan-service";
import { settleLinuxKeyring } from "./linux-keyring";
import { RelayService } from "./relay-service";
import type {
	RelayLoginRequest,
	RelayRegisterRequest,
	RelayResendRequest,
	RelayVerifyRequest,
} from "../shared/relay";
import type { FusionConfig } from "../shared/fusion";
import type { TaskBoardEntry } from "../shared/task-board";
import appIconPng from "../../resources/icons/icon.png?asset";
import appIconIco from "../../resources/icons/icon.ico?asset";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, session, shell, utilityProcess } from "electron";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { AgentService } from "./agent-service";
import { migrateAgentHome } from "./agent-home";
import { ThemeLibrary, resolveThemesDir } from "./theme-library";
import { THEMES_DIR_ENV } from "../shared/themes";
import { AutomationService } from "./automation/service";
import { installBrowserGuards, revokeUnavailableDesktopGuests } from "./browser-service";
import type { BrowserInspector } from "./browser-inspector";

let browserInspector: BrowserInspector | undefined;
import { GitHubAuthService } from "./github-auth";
import { applyAction, getDiff, getStatus, initRepo, listScopeFiles, showHeadFile, commitChanges } from "./git";
import { listProjectFiles, rankPaths } from "./mentions";
import {
	createEntry,
	deletableTarget,
	readTextFile,
	renameEntry,
	searchProject,
	statFiles,
	writeTextFile,
} from "./workspace-files";
import type { IdeCreateRequest, IdeRenameRequest, IdeSearchRequest, IdeWriteRequest } from "../shared/ide";
import { IdeExtensionStore } from "./ide-extensions";
import { ModelConfigService } from "./model-config-service";
import { OAuthService, oauthLoginOptions } from "./oauth-service";
import { AntigravityOAuthService } from "./antigravity-oauth-service";
import { OAuthCredentialStore } from "./oauth-credential-store";
import { createAntigravityFetch } from "./antigravity-transport";
import { resolveProxy } from "./network-proxy";
import { ProxyService } from "./proxy-service";
import { PluginCatalogService } from "./plugin-catalog";
import { PullRequestService } from "./pull-request-service";
import { TerminalService } from "./terminal-service";
import { TokenStatsService } from "./token-stats";
import { tokenUsageCsv } from "./token-usage-export";
import { AppInstallService, appVersionInfo, AppUpdateService, type InstallUpdater } from "./app-updates";
import type {
	InstallPluginRequest,
	PluginActionRequest,
	PluginCatalogQuery,
	SetPluginEnabledRequest,
} from "../shared/plugins";
import type { WorkMode, WorkflowAnswer } from "../shared/workflow";
import type {
	AgentSnapshot,
	DeleteSessionRequest,
	ExecutionMode,
	ExtensionUiAnswer,
	ForkSessionRequest,
	OpenSessionRequest,
	RenameSessionRequest,
	SendPromptRequest,
	StartBackgroundTaskRequest,
	StartBackgroundTaskResult,
	ThinkingLevel,
} from "../shared/agent";
import type { GitActionRequest, GitDiffRequest, ReviewScope } from "../shared/git";
import type {
	CreateSkillRequest,
	ImportSkillsRequest,
	ImportSkillsResult,
	RemoveSkillRequest,
	ScanSkillImportRequest,
	SetSkillEnabledRequest,
} from "../shared/skills";
import type { AppPreferences, CommandShellOption } from "../shared/preferences";
import { configureCommandShell, listCommandShells } from "./command-shell";
import { listSystemFonts } from "./system-fonts";
import type { SystemFont } from "../shared/font-names";
import { configureWebTools, createWebTools, webToolsEnabled } from "./web-tools";
import { codexWebSearch, geminiWebSearch, type CodexSearchAuth } from "./native-search";
import type { AccountSearchEngineId } from "../shared/web-tools";
import { createAstGrepTool } from "./ast-tools";
import { createGithubTool } from "./github-tool";
import { createStatTool } from "./file-tools";
import { WebToolsStore } from "./web-tools-store";
import { CodeIntelStore } from "./code-intel-store";
import { SemanticIndexService } from "./semantic-index/service";
import { configureSemanticSearch, createSemanticSearchTool, semanticSearchEnabled } from "./semantic-search-tool";
import { TabCompletionService } from "./tab-completion";
import { askModel, type ModelCallRuntime } from "./model-call";
import type { CodeIntelModels, CodeIntelUpdate, CompletionRequest } from "../shared/code-intel";
import { codeIntelModelList } from "./code-intel-models";
import { PromptStore } from "./prompt-store";
import { configureCustomPrompt } from "./prompt-library";
import type { PromptsSnapshot, SavePromptRequest } from "../shared/prompts";
import { SshStore } from "./ssh-store";
import { SshService } from "./ssh-service";
import { configureSshTool } from "./ssh-tool";
import { RemoteDesktopService } from "./remote-desktop/service";
import { configureRemoteDesktopTool, type DesktopImageEncoder } from "./remote-desktop/tool";
import type { DesktopController, DesktopKeyInput, DesktopPointerInput } from "../shared/remote-desktop";
import { faviconFor } from "./favicon";
import { configureGithubTool } from "./github-tool";
import type { WebToolsUpdate } from "../shared/web-tools";
import type {
	WorktreeMergeRequest,
	WorktreeMergeResult,
	WorktreeRecord,
	WorktreeStatus,
} from "../shared/worktree";
import type { McpSnapshot, SaveMcpServerRequest } from "../shared/mcp";
import type {
	AcpCreateSessionRequest,
	AcpOpenSessionRequest,
	AcpPermissionResponse,
	AcpPromptRequest,
	AcpSaveAgentRequest,
	AcpSetConfigRequest,
} from "../shared/acp";
import type { QqBotConfig, QqBotStatus } from "../shared/qqbot";
import type { RestoreCheckpointRequest } from "../shared/checkpoints";
import type {
	TerminalCreateRequest,
	TerminalInputRequest,
	TerminalResizeRequest,
} from "../shared/terminal";
import type {
	FetchModelsRequest,
	ModelTestRequest,
	OAuthLoginOptions,
	SaveModelProfileRequest,
} from "../shared/settings";
import type { AutomationEvent, SaveAutomationRequest } from "../shared/automation";
import type {
	CreatePullRequestRequest,
	PullRequestFilter,
} from "../shared/pullRequests";
import {
	FS_IMAGE_MAX_BYTES,
	FS_IMAGE_MIME,
	FS_READ_MAX_BYTES,
	type FsEntry,
	type FsReadResult,
} from "../shared/files";
import { resolveUnderRoot } from "./project-paths";
import {
	EDIT_COMMANDS,
	TITLE_BAR_HEIGHT,
	isWindowMaterial,
	type EditCommand,
	type ShellInfo,
	type WindowMaterial,
} from "../shared/window";
import {
	WindowMaterialStore,
	applyWindowMaterial,
	supportedWindowMaterials,
} from "./window-material";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { WebUiService } from "./webui-service";
import { listHostDirectories } from "./host-directories";
import { hookService, memoryStore } from "./context-services";
import { readProjectInstructions, saveProjectInstructions } from "./project-instructions";
import type { SaveInstructionsRequest } from "../shared/instructions";
import type { SaveMemoryRequest } from "../shared/memory";
import type { SaveHookRequest } from "../shared/hooks";
import type { GoalAction } from "../shared/goal";
import {
	isWebUiEventChannel,
	type SaveWebUiConfigRequest,
	type WebUiBridgeRequest,
	type WebUiBridgeResponse,
	type WebUiRpcMethod,
} from "../shared/webui";

// Set before anything reads app.getPath("userData"): launched as
// `electron out/main/index.js` the entry directory has no package.json, so Electron
// would otherwise name the app "Electron" and share that userData directory with
// every other unnamed Electron app on the machine.
app.setName("NekoCode Desktop");

let taskManager: TaskManager | null = null;
let taskNotifier: TaskNotifier | null = null;
/** Outlives the window: preferences are read again when one is reopened. */
let preferences: AppPreferencesStore | null = null;
let webToolsStore: WebToolsStore | null = null;
let promptStore: PromptStore | null = null;
function prompts(): PromptStore {
	promptStore ??= new PromptStore(app.getPath("userData"));
	return promptStore;
}
/** Lazily, as safeStorage is only usable once the app is ready and the keyring settled. */
function webTools(): WebToolsStore {
	webToolsStore ??= new WebToolsStore(app.getPath("userData"), safeStorage);
	return webToolsStore;
}
let codeIntelStore: CodeIntelStore | null = null;
function codeIntel(): CodeIntelStore {
	codeIntelStore ??= new CodeIntelStore(app.getPath("userData"));
	return codeIntelStore;
}
/** The runtime that reaches every model under Providers and models. */
async function modelCallRuntime(): Promise<ModelCallRuntime> {
	if (!taskManager) throw new Error("Agent service is not running");
	return (await taskManager.active.getModelRuntime()) as unknown as ModelCallRuntime;
}
let semanticIndex: SemanticIndexService | null = null;
/** Window-independent: an index outlives the window that asked for it. */
function semanticIndexService(): SemanticIndexService {
	semanticIndex ??= new SemanticIndexService({
		// Read on every search, so a newly picked model applies at once.
		getAssistant: () => {
			const model = codeIntel().status().searchModel;
			if (!model) return null;
			return {
				model,
				ask: async (systemPrompt, prompt, signal) =>
					askModel(await modelCallRuntime(), model, systemPrompt, prompt, {
						maxTokens: 1024,
						reasoningMaxTokens: 4096,
						timeoutMs: 30_000,
						signal,
					}),
			};
		},
		onStatus: (status) => {
			for (const window of BrowserWindow.getAllWindows()) {
				if (!window.isDestroyed()) window.webContents.send("codeIntel:indexChanged", status);
			}
		},
	});
	return semanticIndex;
}
let tabCompletion: TabCompletionService | null = null;
function tabCompletionService(): TabCompletionService {
	tabCompletion ??= new TabCompletionService({
		settings: () => codeIntel().status().completion,
		getRuntime: modelCallRuntime,
		related: (cwd, text, excludePath, limit) =>
			codeIntel().status().indexEnabled ? semanticIndexService().related(cwd, text, excludePath, limit) : Promise.resolve([]),
	});
	return tabCompletion;
}
let sshState: { store: SshStore; service: SshService } | null = null;
/** Lazily for the same reason; window-independent, since saved hosts outlive a window. */
function ssh(): { store: SshStore; service: SshService } {
	if (!sshState) {
		const store = new SshStore(app.getPath("userData"), safeStorage);
		sshState = { store, service: new SshService(store) };
	}
	return sshState;
}
let remoteDesktops: RemoteDesktopService | null = null;
/** One VNC connection per host, shared by the agent and the panel in every window. */
function desktops(): RemoteDesktopService {
	remoteDesktops ??= new RemoteDesktopService({
		connect: (hostId) => ssh().service.dedicated(hostId),
		emit: (channel, payload) => {
			for (const window of BrowserWindow.getAllWindows())
				if (!window.isDestroyed()) window.webContents.send(channel, payload);
		},
	});
	return remoteDesktops;
}
/**
 * The desktop as the model sees it: a region of the framebuffer, scaled, as
 * JPEG. Only the region is converted — to BGRA, which is what nativeImage takes.
 */
const encodeDesktop: DesktopImageEncoder = (rgba, width, _height, region, target) => {
	const bgra = Buffer.allocUnsafe(region.width * region.height * 4);
	for (let row = 0; row < region.height; row++) {
		let source = ((region.y + row) * width + region.x) * 4;
		let out = row * region.width * 4;
		for (let col = 0; col < region.width; col++, source += 4, out += 4) {
			bgra[out] = rgba[source + 2];
			bgra[out + 1] = rgba[source + 1];
			bgra[out + 2] = rgba[source];
			bgra[out + 3] = 255;
		}
	}
	let image = nativeImage.createFromBitmap(bgra, { width: region.width, height: region.height });
	if (target.width !== region.width || target.height !== region.height) image = image.resize({ ...target, quality: "good" });
	return { data: image.toJPEG(85).toString("base64"), mimeType: "image/jpeg" };
};
/** Also window-independent — a task checkout survives the window that made it. */
let worktrees: WorktreeService | null = null;

const CODEX_PROVIDER = "openai-codex";
/** Fast, and grounded search is what it is for; the answer is only a summary of the sources. */
const GEMINI_SEARCH_MODEL = "gemini-3-flash";
/** Whether each account search engine can run; set once the window's services exist. */
let webSearchAccounts: () => Promise<Record<AccountSearchEngineId, boolean>> = async () => ({ codex: false, gemini: false });

/** The task board as it stands, each task's worktree branch included. */
function taskBoard(): TaskBoardEntry[] {
	if (!taskManager) return [];
	const checkouts = (worktrees ??= new WorktreeService(app.getPath("userData")));
	return taskManager.board((sessionId) => checkouts.forSession(sessionId));
}

/**
 * How often the board is re-sent while tasks run. Every streamed token is a
 * snapshot; the board only needs to keep a status line and a clock current.
 */
const TASK_BOARD_PUSH_MS = 250;
let taskBoardTimer: ReturnType<typeof setTimeout> | null = null;

/** Send the board to every window soon, coalescing the changes until then into one push. */
function pushTaskBoard(): void {
	if (taskBoardTimer) return;
	taskBoardTimer = setTimeout(() => {
		taskBoardTimer = null;
		const board = taskBoard();
		for (const open of BrowserWindow.getAllWindows())
			if (!open.isDestroyed()) open.webContents.send("agent:tasks", board);
	}, TASK_BOARD_PUSH_MS);
}
/** Servers are processes: one set for the app, not one per window or session. */
let mcpService: McpService | null = null;
/** External ACP agents are processes too, and outlive any one window. */
let acpService: AcpService | null = null;
/** NekoCode's tools served over MCP to ACP agents; bound on first use. */
let toolServer: McpToolServer | null = null;

/**
 * The tools an ACP session gets: the ones NekoLocal has — the browser panel,
 * Computer Use when it is switched on, the MCP servers configured in NekoCode —
 * built by the same factories, so both workspaces run one implementation.
 *
 * NekoLocal's read-only code tools ride along: file reading and search,
 * structural search, semantic search over the code index, GitHub, and web
 * access when it is switched on. Agents
 * differ in what they bring — Codex reads the repository through its shell —
 * and these give every agent the same vocabulary. Nothing here writes: an
 * agent's own permission mode or sandbox cannot see a tool served from
 * outside it, so a write tool here would be a way around it.
 */
async function acpToolServers(session: { sessionId: string; cwd: string }): Promise<AcpToolServers> {
	toolServer ??= new McpToolServer({
		version: app.getVersion(),
		// The same argument checks NekoLocal's agent loop applies before a call.
		validate: async (tool, args) =>
			(await piAi()).validateToolArguments(tool as never, { type: "toolCall", id: "", name: tool.name, arguments: args } as never),
	});
	const inspector = browserInspector;
	const browserTools = inspector
		? createWebsiteCloneTools({
				cwd: session.cwd,
				browser: inspector.automationHost(session.sessionId),
				templateDir: resolveWebsiteCloneTemplateDir({
					appPath: app.getAppPath(),
					resourcesPath: process.resourcesPath,
					override: process.env.NEKOCODE_WEBSITE_CLONER_TEMPLATE,
				}),
				// Tagged with this session, so the window opens the preview only
				// while that conversation is the one on screen — as for NekoLocal.
				onNavigate: (request) => {
					for (const win of BrowserWindow.getAllWindows()) {
						win.webContents.send("browser:preview", { ...request, sessionId: session.sessionId, cwd: session.cwd });
					}
				},
			})
		: [];
	const { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition } = await pi();
	// Each carries its own parameter type; `any` is how pi itself holds a mixed set (its `ToolDef`).
	const codeTools: ToolDefinition<any, any>[] = [
		createReadToolDefinition(session.cwd),
		createGrepToolDefinition(session.cwd),
		createFindToolDefinition(session.cwd),
		createLsToolDefinition(session.cwd),
		createStatTool(session.cwd),
		createAstGrepTool(session.cwd),
		...(semanticSearchEnabled() ? [createSemanticSearchTool(session.cwd)] : []),
		createGithubTool(session.cwd),
	];
	const webTools = createWebTools();
	const handle = await toolServer.register({
		tools: () => [
			...codeTools,
			// Read per request, like the rest: switching web access off in
			// settings takes the tools away from a running session at once.
			...(webToolsEnabled() ? webTools : []),
			...browserTools,
			...(computerUse?.tools() ?? []),
			...(mcpService?.tools() ?? []),
		],
	});
	return {
		servers: [{ type: "http", name: "nekocode", url: handle.url, headers: handle.headers }],
		dispose: handle.dispose,
	};
}
/** One desktop driver for the app: every session acts on the same screen. */
let computerUse: ComputerUseService | null = null;
/** One QQ login for the app — a second connection would answer every message twice. */
let qqBotService: QqBotService | null = null;
let lanService: LanService | null = null;
let relayService: RelayService | null = null;
let terminalService: TerminalService | null = null;
let modelConfig: ModelConfigService | null = null;
let oauthService: OAuthService | null = null;
let proxyService: ProxyService | null = null;
let automationService: AutomationService | null = null;
let githubAuth: GitHubAuthService | null = null;
let pullRequests: PullRequestService | null = null;
let tokenStats: TokenStatsService | null = null;
let modelPricing: ModelPricingService | null = null;

/** LiteLLM's price list, for the token panel's cost; pulled daily for as long as the app runs. */
function modelPricingService(): ModelPricingService {
	modelPricing ??= new ModelPricingService({ userDataDir: app.getPath("userData") });
	return modelPricing;
}

/** Wait briefly for prices that are being pulled; a slow network must not hold the panel up. */
async function freshPrices(force = false): Promise<void> {
	await Promise.race([modelPricingService().refresh(force), new Promise((resolve) => setTimeout(resolve, 8_000))]);
}
let webUiService: WebUiService | null = null;
let contextBroadcasts = false;
let webUiBridge: WebContents | null = null;
const webUiPending = new Map<
	string,
	{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>();

const WEBUI_BRIDGE_TIMEOUT_MS = 10 * 60_000;

function webUiInvoke(method: WebUiRpcMethod, args: unknown[]): Promise<unknown> {
	const bridge = webUiBridge;
	if (!bridge || bridge.isDestroyed()) {
		return Promise.reject(new Error("WebUI bridge unavailable: the desktop window is not ready"));
	}
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			webUiPending.delete(id);
			reject(new Error("WebUI bridge request timed out"));
		}, WEBUI_BRIDGE_TIMEOUT_MS);
		webUiPending.set(id, { resolve, reject, timer });
		try {
			bridge.send("webui:rpc", { id, method, args } satisfies WebUiBridgeRequest);
		} catch (error) {
			webUiPending.delete(id);
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function webUiBridgeGone(sender: WebContents): void {
	if (webUiBridge !== sender) return;
	webUiBridge = null;
	for (const [id, pending] of webUiPending) {
		clearTimeout(pending.timer);
		pending.reject(new Error("WebUI bridge closed"));
		webUiPending.delete(id);
	}
}

function isWebUiBridgeResponse(value: unknown): value is WebUiBridgeResponse {
	if (!value || typeof value !== "object") return false;
	const response = value as { id?: unknown; ok?: unknown; error?: unknown };
	if (typeof response.id !== "string" || response.id.length === 0 || response.id.length > 128) return false;
	if (response.ok === true) return true;
	return response.ok === false && typeof response.error === "string";
}

/**
 * The token panel reads the transcripts directly, so it needs no session to be
 * open and survives the agent service being torn down with a window. It keeps
 * its incremental parse state, which is what makes a refresh cheap.
 */
function tokenStatsService(): TokenStatsService {
	if (!tokenStats) {
		tokenStats = new TokenStatsService({
			sessionDir: join(app.getPath("userData"), "sessions"),
			automationDir: join(app.getPath("userData"), "automation-sessions"),
			providerLabels: () =>
				Object.fromEntries(
					(modelConfig?.list() ?? []).map((profile) => [`nekocode-${profile.id}`, profile.name]),
				),
			prices: () => modelPricingService().prices(),
			pricingStatus: () => modelPricingService().status(),
		});
	}
	return tokenStats;
}

/**
 * Run a prompt in a session of its own.
 *
 * Shared by the composer's background button and the QQ bot rather than living
 * in the IPC handler, because isolation has to be decided before the session
 * exists — the worktree is the directory the session is created in.
 *
 * `isolate` is passed rather than read from preferences here: the two callers do
 * not want the same default. Someone pressing the background button is at the
 * desktop, where a task's worktree is visible and mergeable; someone messaging
 * from QQ is not, and an isolated run would report success against a checkout
 * they never see change.
 */
async function startBackgroundTask(
	cwd: string,
	text: string,
	/** Omitted means "whatever the desktop preference says". */
	isolate?: boolean,
	/** Applied to the new session before its first prompt runs. */
	configure?: (agent: AgentService) => Promise<void>,
): Promise<StartBackgroundTaskResult> {
	if (!taskManager) throw new Error("Agent service unavailable");
	preferences ??= new AppPreferencesStore(app.getPath("userData"));
	worktrees ??= new WorktreeService(app.getPath("userData"));
	const workspace: PreparedWorkspace = (isolate ?? preferences.get().isolateBackgroundTasks)
		? await worktrees.prepare(cwd)
		: { cwd, worktree: null };
	const result = await taskManager.startBackground(workspace.cwd, text, configure);
	if (!result.accepted) {
		// The task never started, so its checkout is an empty directory and a
		// branch nobody will ever look at.
		if (workspace.worktree) await worktrees.discardPrepared(workspace.worktree);
		return result;
	}
	worktrees.attach(result.session.id, result.session.sessionFile, workspace.worktree);
	// The task went on the board before its checkout was recorded against it.
	if (workspace.worktree) pushTaskBoard();
	return { ...result, ...(workspace.warning ? { warning: workspace.warning } : {}) };
}

/**
 * Build the QQ connection on top of the running task manager.
 *
 * State is broadcast to whatever windows exist at the time rather than captured
 * from one of them: a connection made before the settings panel was opened has
 * no window to have remembered.
 */
function createQqBotService(): QqBotService {
	const service = new QqBotService({
		userDataDir: app.getPath("userData"),
		// Never isolated: a QQ task edits the project the way a local one does, and
		// checkpoints are its undo. A branch in a directory under this app's data
		// folder is not something anyone can review from a chat.
		startTask: (cwd, text, options) =>
			startBackgroundTask(cwd, text, false, async (agent) => {
				// Before the prompt, not after: a configure that landed later would
				// have the first turn already out on the desktop's model.
				if (options.modelKey) await agent.setModel(options.modelKey);
				if (options.thinkingLevel) await agent.setThinkingLevel(options.thinkingLevel);
			}),
		defaults: async (cwd) => {
			if (!taskManager) throw new Error("Agent service unavailable");
			return taskManager.defaults(cwd || app.getPath("home"));
		},
		configure: async (sessionId, options) => {
			if (!taskManager) throw new Error("Agent service unavailable");
			const agent = await taskManager.byId(sessionId);
			if (options.modelKey) await agent.setModel(options.modelKey);
			if (options.thinkingLevel) await agent.setThinkingLevel(options.thinkingLevel);
		},
		renderBlock: (block) => renderBlock(block),
		checkpoints: async (sessionId) => {
			if (!taskManager) return [];
			return (await taskManager.byId(sessionId)).listCheckpoints();
		},
		restoreCheckpoint: async (sessionId, id) => {
			if (!taskManager) throw new Error("Agent service unavailable");
			// Code only: rewinding the conversation as well would drop the very
			// messages the chat is still reading.
			return (await taskManager.byId(sessionId)).restoreCheckpoint({ id, scope: "code" });
		},
		resolveDirectory: async (path) => {
			const trimmed = path.trim().replace(/^["']|["']$/g, "");
			if (!isAbsolute(trimmed)) throw new Error("请使用绝对路径");
			const canonical = await realpath(trimmed).catch(() => {
				throw new Error(`目录不存在：${trimmed}`);
			});
			if (!(await stat(canonical)).isDirectory()) throw new Error("这不是一个文件夹");
			return canonical;
		},
		sendTo: async (sessionId, text) => {
			if (!taskManager) throw new Error("Agent service unavailable");
			return (await taskManager.byId(sessionId)).send({ text });
		},
		snapshot: async (sessionId) => {
			if (!taskManager) return null;
			return (await taskManager.byId(sessionId)).getSnapshot();
		},
		abort: async (sessionId) => {
			if (!taskManager) return;
			await (await taskManager.byId(sessionId)).abort();
		},
		answerWorkflow: async (sessionId, answer) => {
			if (!taskManager) throw new Error("Agent service unavailable");
			(await taskManager.byId(sessionId)).answerWorkflow(answer);
		},
		onChange: () => {
			const snapshot = qqBotService?.snapshot();
			for (const open of BrowserWindow.getAllWindows()) {
				if (!open.isDestroyed()) open.webContents.send("qqbot:changed", snapshot);
			}
		},
	});
	service.refresh();
	return service;
}

/**
 * First CLI argument that names an existing directory. `electron . <dir>` (or a
 * packaged binary invoked as `nekocode-desktop <dir>`) opens that project
 * directly instead of waiting for the folder picker.
 */
function initialProjectDirectory(): string | null {
	// Chromium's own switches and the entry script both appear in argv, so the
	// project directory is identified by shape instead of position: the first
	// non-flag argument that is an existing directory and is not the app itself.
	const appPath = app.getAppPath();
	for (const argument of process.argv.slice(1)) {
		if (argument.startsWith("-")) continue;
		const candidate = resolve(argument);
		if (candidate === appPath || candidate.startsWith(appPath + sep)) continue;
		if (candidate.endsWith(".js") || candidate.endsWith(".asar")) continue;
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		} catch {
			// unreadable path; keep looking
		}
	}
	return null;
}

/**
 * The window shell the renderer lays out against. Resolved once at startup so
 * the preload can hand it over synchronously and the first paint already knows
 * which material it is sitting on.
 */
const supportedMaterials = supportedWindowMaterials();
let themeLibraryInstance: ThemeLibrary | null = null;
/** Community themes; the folder is watched from startup so the agent can drop packages in. */
function themeLibrary(): ThemeLibrary {
	themeLibraryInstance ??= new ThemeLibrary(
		resolveThemesDir(process.env, process.env.PI_CODING_AGENT_DIR?.trim() || join(app.getPath("home"), ".nekocode", "agent")),
		(path) => shell.trashItem(path),
	);
	return themeLibraryInstance;
}

let windowMaterialStore: WindowMaterialStore | null = null;
let activeMaterial: WindowMaterial = "opaque";

function shellInfo(): ShellInfo {
	return {
		material: activeMaterial,
		materials: supportedMaterials,
		titleBarHeight: TITLE_BAR_HEIGHT,
	};
}

/** The solid shell color, used whenever no backdrop is behind the window. */
function opaqueBackgroundColor(): string {
	return nativeTheme.shouldUseDarkColors ? "#1a1a19" : "#f9f9f7";
}

/**
 * The caption glyphs are drawn by Windows, not by us, so they only get a single
 * color. Follow the resolved system theme, which the renderer keeps in sync
 * through `theme:set`.
 */
function captionOverlay() {
	return {
		// Transparent so the title bar row behind the buttons (and whatever
		// material backs the window) shows through instead of a flat patch of color.
		color: "#00000000",
		symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#1a1a19",
		height: TITLE_BAR_HEIGHT,
	};
}

/** How long a new window may stay hidden waiting for its first paint. */
const WINDOW_REVEAL_TIMEOUT_MS = 2000;

function createWindow(): void {
	// A system backdrop is composited behind the window by DWM, so the window's
	// own background has to be fully transparent for it to show at all. Bound to
	// a local so the narrowing survives into the options object below.
	const material = activeMaterial;
	const backdrop = material === "mica" || material === "acrylic";
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1100,
		minHeight: 700,
		title: "NekoCode Desktop",
		icon: process.platform === "win32" ? appIconIco : appIconPng,
		// Shown on first paint (below), which is the boot splash — never the
		// empty backdrop the window is before its page has loaded.
		show: false,
		backgroundColor: backdrop ? "#00000000" : opaqueBackgroundColor(),
		// Only handed over on the platforms that understand it: elsewhere the
		// option is inert at best, and on Windows 10 the backdrop it asks for is
		// what turns the window into a blank rectangle.
		...(backdrop ? { backgroundMaterial: material } : {}),
		// The app draws its own caption strip. `hidden` rather than `frame: false`
		// so Windows still gives the window its rounded corners, drop shadow and
		// resize borders; the caption buttons stay system-drawn (below) so Snap
		// Layouts keeps working.
		titleBarStyle:
			process.platform === "darwin"
				? "hiddenInset"
				: process.platform === "win32"
					? "hidden"
					: "default",
		...(process.platform === "win32" ? { titleBarOverlay: captionOverlay() } : {}),
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// The browser panel hosts its pages in renderer-owned <webview> guests;
			// installBrowserGuards() pins their web preferences.
			webviewTag: true,
		},
	});

	// The first paint is the splash in index.html, a few milliseconds after the
	// HTML arrives. The timer is for a page that never paints — a load that
	// failed or hangs — where a window late is better than no window at all.
	let revealTimer: NodeJS.Timeout | undefined;
	const reveal = () => {
		clearTimeout(revealTimer);
		if (!win.isDestroyed() && !win.isVisible()) win.show();
	};
	revealTimer = setTimeout(reveal, WINDOW_REVEAL_TIMEOUT_MS);
	win.once("ready-to-show", reveal);

	// Start loading the page now rather than after the services below: the
	// renderer fetches and parses the bundle in parallel with them, and the boot
	// splash in index.html paints the moment the HTML arrives. Safe this early
	// because this function is synchronous — no IPC from the page, and no
	// webContents event, is handled until it has returned with everything built.
	if (process.env.ELECTRON_RENDERER_URL) {
		void win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void win.loadFile(join(__dirname, "../renderer/index.html"));
	}

	const inspector = installBrowserGuards(win, () => mcpService?.desktopViewers() ?? []);
	browserInspector = inspector;

	if (process.platform === "win32") {
		// Repaint the caption glyphs when the app flips light/dark, otherwise they
		// stay in the color they had when the window opened.
		const syncOverlay = () => {
			if (!win.isDestroyed()) win.setTitleBarOverlay(captionOverlay());
		};
		nativeTheme.on("updated", syncOverlay);
		win.on("closed", () => nativeTheme.off("updated", syncOverlay));
	}

	if (!modelConfig) modelConfig = new ModelConfigService();
	const antigravity = new AntigravityOAuthService({
			store: new OAuthCredentialStore(app.getPath("userData"), safeStorage),
			fetch: createAntigravityFetch(async (targetUrl) => {
				const manual = proxyService?.current().manual;
				const resolution = await resolveProxy({
					...(manual != null ? { manual } : {}), env: process.env, targetUrl,
					resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
				});
				if (resolution.warning) throw new Error(resolution.warning);
				return resolution.url;
			}),
			openExternal: (url) => shell.openExternal(url),
			emit: (event) => { if (!win.isDestroyed()) win.webContents.send("oauth:event", event); },
	});
	preferences ??= new AppPreferencesStore(app.getPath("userData"));
	// Read per session, so a change applies to the next one without a restart.
	configureCommandShell(() => preferences?.get().commandShell ?? "auto");
	// The account search engines borrow the model sign-ins; see native-search.ts.
	const codexSearchAuth = async (): Promise<CodexSearchAuth | null> => {
		const runtime = await taskManager?.active.getModelRuntime();
		if (!runtime) return null;
		const status = runtime.getProviderAuthStatus(CODEX_PROVIDER);
		if (!(status.configured && status.source === "stored")) return null;
		const token = (await runtime.getAuth(CODEX_PROVIDER))?.auth.apiKey;
		if (!token) return null;
		// The model on screen when it is a Codex one — the account demonstrably
		// has it — otherwise the first the catalog lists.
		const models = runtime.getModels(CODEX_PROVIDER).map((model) => model.id);
		const active = taskManager?.active.getSnapshot()?.modelKey ?? "";
		const onScreen = active.startsWith(`${CODEX_PROVIDER}/`) ? active.slice(CODEX_PROVIDER.length + 1) : null;
		const model = onScreen && models.includes(onScreen) ? onScreen : models[0];
		return model ? { accessToken: token, model } : null;
	};
	webSearchAccounts = async () => ({
		codex: (await codexSearchAuth().catch(() => null)) !== null,
		gemini: antigravity.list().signedIn,
	});
	configureWebTools(() => ({
		...webTools().settings(),
		native: {
			codex: async (request) => {
				const auth = await codexSearchAuth();
				if (!auth) throw new Error("OpenAI Codex is not signed in");
				return codexWebSearch(request, auth);
			},
			gemini: async (request) => {
				const context = await antigravity.requestContext(request.signal);
				return geminiWebSearch(request, {
					projectId: context.projectId,
					model: GEMINI_SEARCH_MODEL,
					send: (payload) => antigravity.sendModelRequest(payload, context),
				});
			},
		},
	}));
	configureGithubTool(() => githubAuth);
	configureSshTool(ssh);
	configureRemoteDesktopTool(() => ({ store: ssh().store, service: desktops(), encode: encodeDesktop }));
	taskNotifier = new TaskNotifier(win, preferences.get().notifyOnTaskFinish, (session) => {
		if (!win.isDestroyed()) win.webContents.send("agent:revealSession", session);
	});
	// Servers are dialled against the project the window is on, and a stdio
	// server's cwd is the only context it gets about which one that is.
	mcpService ??= new McpService(
		app.getPath("userData"),
		() => taskManager?.active.getSnapshot()?.session.cwd ?? app.getPath("home"),
		() => {
			for (const window of BrowserWindow.getAllWindows()) {
				if (window.isDestroyed()) continue;
				revokeUnavailableDesktopGuests(window, mcpService?.desktopViewers() ?? []);
				window.webContents.send("mcp:changed", mcpService?.snapshot());
			}
		},
		{
			version: app.getVersion(),
			auth: new McpAuthStore(app.getPath("userData"), safeStorage),
			openUrl: (url) => shell.openExternal(url),
		},
	);
	if (!contextBroadcasts) {
		contextBroadcasts = true;
		// Both change without the page asking: the agent saves memories, and every
		// tool call can add a hook run to the log.
		const broadcast = (channel: string, payload: unknown) => {
			for (const window of BrowserWindow.getAllWindows())
				if (!window.isDestroyed()) window.webContents.send(channel, payload);
		};
		memoryStore().onChange(() => broadcast("memory:changed", { entries: memoryStore().list() }));
		hookService().onChange((snapshot) => broadcast("hooks:changed", snapshot));
	}
	computerUse ??= new ComputerUseService({
		enabled: () => preferences?.get().computerUse ?? false,
		fork: () => utilityProcess.fork(join(__dirname, "computer-worker.js"), [], {
			serviceName: "NekoCode Computer Use",
		}),
		pointer: new CursorOverlay(),
	});
	// Sessions take their extra tools from one place: the MCP servers' and, when
	// switched on, Computer Use's. Both are read when a session starts.
	const extraTools = {
		tools: () => [...(mcpService?.tools() ?? []), ...(computerUse?.tools() ?? [])],
		toolNames: () => [...(mcpService?.toolNames() ?? []), ...(computerUse?.toolNames() ?? [])],
	};
	taskManager = new TaskManager((emit, owner) => new AgentService(win, modelConfig!, inspector, antigravity, { emit, owner }, extraTools),
		(channel, payload) => { if (!win.isDestroyed()) win.webContents.send(channel, payload); },
		(session, selected) => {
			taskNotifier?.settled(session, selected);
			// The chat that started a task is not watching the window, so the same
			// signal that raises a toast is what sends its answer back to QQ.
			qqBotService?.settled(session);
		},
		// Progress, not just completion: QQ streams a run as it happens and has to
		// relay a workflow question the moment it blocks the task.
		(snapshot) => qqBotService?.progress(snapshot),
		pushTaskBoard);
	// After the manager exists, so a stdio server's cwd can resolve to the open
	// project rather than to the fallback.
	void mcpService.refresh();
	qqBotService ??= createQqBotService();
	lanService = new LanService(app.getPath("userData"), taskManager);
	void lanService.restore().catch((error) => console.error("LAN restore:", error));
	relayService = new RelayService({
		userDataDir: app.getPath("userData"),
		encryption: safeStorage,
		gateway: lanService,
		emit: (status) => { if (!win.isDestroyed()) win.webContents.send("relay:changed", status); },
	});
	void relayService.start();
	oauthService = new OAuthService({
		antigravity,
		userDataDir: app.getPath("userData"),
		getRuntime: () => {
			if (!taskManager) throw new Error("Agent service unavailable");
			return taskManager!.active.getModelRuntime();
		},
		// The sign-in page opens in the real browser, never in an app window: the
		// user has to see the address bar they are typing their password into.
		openExternal: (url) => void shell.openExternal(url),
		emit: (event) => {
			if (!win.isDestroyed()) win.webContents.send("oauth:event", event);
		},
	});
	terminalService = new TerminalService(win, () => ssh().service);

	if (!githubAuth) githubAuth = new GitHubAuthService();
	if (!pullRequests) pullRequests = new PullRequestService(githubAuth);
	if (!automationService) {
		automationService = new AutomationService({
			userDataDir: app.getPath("userData"),
			// Automation runs get their own session directory: a run creates a PI
			// session, and sharing the interactive directory would make every
			// scheduled run show up as a session in the sidebar.
			sessionsDir: join(app.getPath("userData"), "automation-sessions"),
			getModelRuntime: async () => {
				if (!taskManager) throw new Error("Agent service is not running");
				return taskManager!.active.getModelRuntime();
			},
			onEvent: (event: AutomationEvent) => {
				if (!win.isDestroyed()) win.webContents.send("automation:event", event);
			},
		});
		automationService.start();
	}

	// Taken now: by "closed" the window is destroyed, and reading `webContents`
	// off it throws — which used to abort this handler on its first line and
	// skip every shutdown step below it.
	const contents = win.webContents;
	win.on("closed", () => {
		webUiBridgeGone(contents);
		oauthService?.close();
		terminalService?.killAll();
		relayService?.close();
		taskManager?.close(); void lanService?.stop();
		// The bot runs tasks through the task manager, so it cannot outlive one:
		// staying connected would only collect messages it has no way to answer.
		qqBotService?.close();
		// The agent cursor is a window too: left open, it would keep the app
		// from quitting once this, the last real window, is gone.
		computerUse?.dispose();
		relayService = null;
		taskManager = null; lanService = null; taskNotifier = null;
		qqBotService = null; terminalService = null;
	});

	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});
	// The window is the app, never a page: a link that slips past the renderer's
	// own handling would otherwise replace the whole UI with the site. A reload
	// stays on the app's own URL and passes; a web link goes to the system browser.
	win.webContents.on("will-navigate", (event, url) => {
		if (url.split("#")[0] === win.webContents.getURL().split("#")[0]) return;
		event.preventDefault();
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
	});
}

function registerIpc(): void {
	const versionInfo = () => appVersionInfo(app.isPackaged, app.getVersion());
	const appUpdates = new AppUpdateService({
		currentVersion: () => versionInfo().version,
		resolveToken: async () => (await githubAuth?.resolveToken())?.token ?? null,
	});
	ipcMain.handle("app:version", versionInfo);
	ipcMain.handle("app:checkForUpdates", () => appUpdates.check());
	ipcMain.handle("app:checkForUpdatesOnStartup", () => appUpdates.checkOnStartup());
	ipcMain.handle("app:dismissStartupUpdate", () => appUpdates.dismissStartupUpdate());
	const appInstall = new AppInstallService({
		// macOS needs a Developer ID for Squirrel.Mac and deb needs root: both
		// keep the release page. APPIMAGE is set by the AppImage runtime.
		supported: app.isPackaged && (process.platform === "win32" || (process.platform === "linux" && !!process.env.APPIMAGE)),
		currentVersion: () => versionInfo().version,
		loadUpdater: async () => {
			// import() of a CommonJS module: Node cannot detect `autoUpdater` (a
			// getter) as a named export, so it is only on the default export.
			const module = await import("electron-updater");
			return (module.autoUpdater ?? module.default.autoUpdater) as unknown as InstallUpdater;
		},
		publish: (state) => {
			for (const window of BrowserWindow.getAllWindows())
				if (!window.isDestroyed()) window.webContents.send("app:updateInstallState", state);
		},
	});
	ipcMain.handle("app:updateInstallState", () => appInstall.state());
	ipcMain.handle("app:downloadUpdate", (_event, tag: unknown) => appInstall.download(tag));
	ipcMain.handle("app:installUpdate", () => appInstall.install());
	ipcMain.handle("browser:setInspect", (event, guestId: number, enabled: boolean) => {
		if (!Number.isInteger(guestId) || typeof enabled !== "boolean") throw new Error("Invalid inspector request");
		return browserInspector?.setInspect(event.sender, guestId, enabled);
	});
	ipcMain.handle("browser:bindAutomation", (event, requestId: string, guestId: number) => {
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128 || !Number.isInteger(guestId)) {
			throw new Error("Invalid automation bind request");
		}
		if (!browserInspector) throw new Error("Browser automation is unavailable");
		return browserInspector.bindAutomation(event.sender, requestId, guestId);
	});
	ipcMain.handle("app:initialProjectDir", () => initialProjectDirectory());

	// Synchronous on purpose: the preload reads this once at load time so the
	// theme can pick its shell material before the first paint, with no flash of
	// the wrong background.
	ipcMain.on("app:shellInfo", (event) => {
		event.returnValue = shellInfo();
	});

	// The renderer owns the picker, so the choice arrives here to be applied and
	// remembered; `app:shellInfo` is the read path back (on the next launch, and
	// for the picker's own list of what this machine can render).
	ipcMain.handle("window:setMaterial", (event, material: unknown) => {
		if (!isWindowMaterial(material)) {
			throw new Error(`Unknown window material: ${String(material)}`);
		}
		// Refuse rather than apply: below Windows 11 22H2 a backdrop leaves the
		// window transparent over nothing.
		if (!supportedMaterials.includes(material)) {
			throw new Error(`Window material is not supported on this system: ${material}`);
		}
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) throw new Error("Window material can only be set from a window");
		activeMaterial = material;
		applyWindowMaterial(win, material, opaqueBackgroundColor());
		windowMaterialStore?.save(material === "opaque" ? null : material);
		return shellInfo();
	});

	// Also synchronous: it is the default working directory, so the welcome
	// screen needs it in its first render rather than a tick later.
	ipcMain.on("app:homeDir", (event) => {
		event.returnValue = app.getPath("home");
	});

	ipcMain.handle("browser:openExternal", (_event, url: string) => {
		if (!/^https?:\/\//i.test(url)) {
			throw new Error(`Refusing to open non-http(s) URL: ${url}`);
		}
		return shell.openExternal(url);
	});

	ipcMain.handle("theme:set", (_event, theme: "light" | "dark" | "system") => {
		if (theme === "light" || theme === "dark" || theme === "system") {
			nativeTheme.themeSource = theme;
		}
	});

	ipcMain.handle("git:status", (_e, cwd: string) => getStatus(cwd));
	ipcMain.handle("git:diff", (_e, req: GitDiffRequest) => getDiff(req));
	ipcMain.handle("git:files", (_e, cwd: string, scope: ReviewScope) =>
		listScopeFiles(cwd, scope),
	);
	ipcMain.handle("git:action", (_e, req: GitActionRequest) => applyAction(req));
	ipcMain.handle("git:init", (_e, cwd: string) => initRepo(cwd));

	ipcMain.handle("fs:list", async (_e, cwd: string, relPath: string): Promise<FsEntry[]> => {
		const { target, relPath: base } = resolveUnderRoot(cwd, relPath);
		const dirents = await readdir(target, { withFileTypes: true });
		return dirents
			.filter((entry) => entry.isDirectory() || entry.isFile())
			.map((entry) => ({
				name: entry.name,
				relPath: base === "" ? entry.name : join(base, entry.name),
				kind: entry.isDirectory() ? ("dir" as const) : ("file" as const),
			}))
			.sort((a, b) =>
				a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
			);
	});

	ipcMain.handle(
		"fs:readFile",
		async (_e, cwd: string, relPath: string): Promise<FsReadResult> => {
			const resolved = resolveUnderRoot(cwd, relPath);
			const info = await stat(resolved.target);
			if (!info.isFile()) throw new Error(`Not a file: ${relPath}`);
			// The caller may have asked by absolute path; answer with the one the
			// pane can navigate and display.
			const rel = resolved.relPath;
			const mime = FS_IMAGE_MIME[extname(rel).slice(1).toLowerCase()];
			if (mime) {
				if (info.size > FS_IMAGE_MAX_BYTES) return { kind: "binary", relPath: rel, size: info.size };
				const image = await readFile(resolved.target);
				return {
					kind: "image",
					relPath: rel,
					dataUrl: `data:${mime};base64,${image.toString("base64")}`,
					size: info.size,
				};
			}
			const buffer = await readFile(resolved.target);
			if (buffer.includes(0)) return { kind: "binary", relPath: rel, size: info.size };
			return {
				kind: "text",
				relPath: rel,
				text: buffer.subarray(0, FS_READ_MAX_BYTES).toString("utf8"),
				truncated: info.size > FS_READ_MAX_BYTES,
			};
		},
	);
	// The IDE layout's editor and explorer. Same root check as the Files pane.
	ipcMain.handle("ide:readText", (_e, cwd: string, relPath: string) => readTextFile(cwd, relPath));
	ipcMain.handle("ide:writeText", (_e, request: IdeWriteRequest) => writeTextFile(request));
	ipcMain.handle("ide:create", (_e, request: IdeCreateRequest) => createEntry(request));
	ipcMain.handle("ide:rename", (_e, request: IdeRenameRequest) => renameEntry(request));
	// To the recycle bin: an explorer delete is one misclick from the wrong file.
	ipcMain.handle("ide:delete", (_e, cwd: string, relPath: string) => shell.trashItem(deletableTarget(cwd, relPath)));
	ipcMain.handle("ide:stat", (_e, cwd: string, relPaths: string[]) =>
		statFiles(cwd, Array.isArray(relPaths) ? relPaths.slice(0, 500) : []),
	);
	ipcMain.handle("ide:quickOpen", async (_e, cwd: string, query: string) => {
		const files = await listProjectFiles(cwd);
		return rankPaths(files, query, 60)
			.filter((candidate) => candidate.kind === "file")
			.map((candidate) => candidate.path);
	});
	ipcMain.handle("ide:search", async (_e, request: IdeSearchRequest) =>
		searchProject(await listProjectFiles(request.cwd), request),
	);
	ipcMain.handle("ide:gitHead", (_e, cwd: string, relPath: string) => showHeadFile(cwd, relPath));
	// VS Code extensions for the IDE: data only, applied by the renderer.
	const ideExtensions = new IdeExtensionStore(join(app.getPath("userData"), "ide-extensions"));
	ideExtensions.cleanStaging();
	ipcMain.handle("ideExt:list", (_e, locale: unknown) => {
		if (typeof locale === "string") ideExtensions.setLocale(locale);
		return ideExtensions.snapshot();
	});
	ipcMain.handle("ideExt:search", (_e, query: unknown) => ideExtensions.search(typeof query === "string" ? query : ""));
	ipcMain.handle("ideExt:install", (_e, id: string) => ideExtensions.install(id));
	ipcMain.handle("ideExt:installVsix", async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return null;
		const picked = await dialog.showOpenDialog(win, {
			title: "从 VSIX 安装扩展",
			properties: ["openFile"],
			filters: [{ name: "VS Code 扩展", extensions: ["vsix"] }],
		});
		const file = picked.filePaths[0];
		if (picked.canceled || !file) return null;
		return ideExtensions.installVsix(await readFile(file));
	});
	ipcMain.handle("ideExt:uninstall", (_e, id: string) => ideExtensions.uninstall(id));
	ipcMain.handle("ideExt:setEnabled", (_e, id: string, enabled: boolean) => ideExtensions.setEnabled(id, enabled === true));
	ipcMain.handle("ideExt:readFile", (_e, id: string, relPath: string) => ideExtensions.readFile(id, relPath));
	// The regex engine TextMate grammars need, as wasm. Read here and handed
	// over: the page is a `file://` URL in a packaged build, which its own
	// `fetch` cannot read, and bundling the binary would put it in the JS.
	ipcMain.handle("ideExt:oniguruma", () => readFile(join(dirname(require.resolve("vscode-oniguruma")), "onig.wasm")));
	ipcMain.handle("ide:gitCommit", (_e, cwd: string, message: string, all: boolean) =>
		commitChanges(cwd, String(message ?? ""), all === true),
	);
	ipcMain.handle("directory:list", (_e, path: unknown) => listHostDirectories(path));
	ipcMain.handle("lan:addProjectPath", (_e, path: unknown) => {
		if (typeof path !== "string" || !path || path.length > 4096 || !lanService) {
			throw new Error("无效的项目目录");
		}
		return lanService.addProject(path);
	});
	ipcMain.handle("dialog:openDirectory", async (e) => {
		const win = BrowserWindow.fromWebContents(e.sender);
		if (!win) return null;
		const result = await dialog.showOpenDialog(win, {
			properties: ["openDirectory"],
			title: "打开项目目录",
		});
		return result.canceled ? null : result.filePaths[0];
	});

	ipcMain.handle("lan:status", () => lanService?.status());
	ipcMain.handle("lan:enabled", (_e, enabled: boolean) => {
		if (typeof enabled !== "boolean" || !lanService) throw new Error("LAN service unavailable");
		return lanService.setEnabled(enabled);
	});
	ipcMain.handle("lan:pairing", () => lanService?.newPairing());
	ipcMain.handle("lan:revoke", (_e, id: string) => lanService?.revoke(id));
	ipcMain.handle("lan:removeProject", (_e, id: string) => lanService?.removeProject(id));
	ipcMain.handle("lan:addProject", async (e) => {
		const win = BrowserWindow.fromWebContents(e.sender);
		if (!win || !lanService) throw new Error("LAN service unavailable");
		const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "允许手机创建任务的项目" });
		return result.canceled ? lanService.status() : lanService.addProject(result.filePaths[0]);
	});

	ipcMain.handle("relay:status", () => relayService?.status());
	ipcMain.handle("relay:login", (_e, request: RelayLoginRequest) => {
		if (!request || typeof request !== "object" || typeof request.email !== "string" || request.email.length > 254 ||
			typeof request.password !== "string" || request.password.length === 0 || request.password.length > 256) {
			throw new Error("Invalid relay login request");
		}
		if (!relayService) throw new Error("Relay service unavailable");
		return relayService.login(request);
	});
	ipcMain.handle("relay:register", (_e, request: RelayRegisterRequest) => {
		if (!request || typeof request !== "object" || typeof request.email !== "string" ||
			!request.email.trim() || request.email.length > 254 ||
			typeof request.password !== "string" || request.password.length < 8 || request.password.length > 256) {
			throw new Error("Invalid relay register request");
		}
		if (!relayService) throw new Error("Relay service unavailable");
		return relayService.register(request);
	});
	ipcMain.handle("relay:verify", (_e, request: RelayVerifyRequest) => {
		if (!request || typeof request !== "object" || typeof request.email !== "string" ||
			!request.email.trim() || request.email.length > 254 ||
			typeof request.code !== "string" || !/^\d{6}$/.test(request.code.trim())) {
			throw new Error("Invalid relay verify request");
		}
		if (!relayService) throw new Error("Relay service unavailable");
		return relayService.verify(request);
	});
	ipcMain.handle("relay:resend", (_e, request: RelayResendRequest) => {
		if (!request || typeof request !== "object" || typeof request.email !== "string" ||
			!request.email.trim() || request.email.length > 254) {
			throw new Error("Invalid relay resend request");
		}
		if (!relayService) throw new Error("Relay service unavailable");
		return relayService.resend(request);
	});
	ipcMain.handle("relay:logout", () => {
		if (!relayService) throw new Error("Relay service unavailable");
		return relayService.logout();
	});
	ipcMain.handle("relay:reconnect", () => {
		if (!relayService) throw new Error("Relay service unavailable");
		return relayService.reconnect();
	});

	ipcMain.handle("agent:listSessions", (_e, cwd?: string) =>
		taskManager?.list(cwd),
	);
	ipcMain.handle("agent:create", (_e, cwd: string) =>
		taskManager?.create(cwd).then((agent) => taskManager?.viewOf(agent) ?? null),
	);
	ipcMain.handle("agent:open", (_e, req: OpenSessionRequest) =>
		taskManager?.open(req).then((agent) => taskManager?.viewOf(agent) ?? null),
	);
	ipcMain.handle("agent:watchPanes", (_e, reqs: unknown) => {
		if (!Array.isArray(reqs) || reqs.length > 4 || !reqs.every((req) =>
			req && typeof req === "object" && typeof req.cwd === "string" && typeof req.sessionFile === "string")) {
			throw new Error("Invalid pane request");
		}
		return taskManager?.watch(reqs as OpenSessionRequest[]) ?? [];
	});
	// The branch is written beside the session on screen, then opened like any
	// other: the original stays in the sidebar, untouched, to go back to.
	ipcMain.handle("agent:fork", async (_e, req: ForkSessionRequest) => {
		if (!req || typeof req !== "object" || typeof req.cellId !== "string" ||
			(req.title !== undefined && typeof req.title !== "string")) {
			throw new Error("Invalid fork request");
		}
		const manager = taskManager;
		if (!manager) return null;
		const target = await manager.active.forkAt(req);
		return manager.open(target).then((agent) => manager.viewOf(agent));
	});
	/**
	 * A snapshot on its way back to the window, cut to the window's view of it.
	 * Every handler that answers with the selected session's snapshot goes
	 * through this — see `TaskManager.view` for why none may skip it.
	 */
	const toWindow = async (
		result: AgentSnapshot | null | undefined | Promise<AgentSnapshot | null | undefined>,
	): Promise<AgentSnapshot | null> => {
		const snapshot = await result;
		return snapshot && taskManager ? taskManager.view(snapshot) : (snapshot ?? null);
	};
	ipcMain.handle("agent:loadEarlier", () => taskManager?.loadEarlier() ?? null);
	ipcMain.handle("agent:toolOutput", (_e, toolCallId: string, offset: number) =>
		taskManager?.active.toolOutput(toolCallId, offset) ?? null,
	);
	ipcMain.handle("agent:rename", (_e, req: RenameSessionRequest) =>
		taskManager?.rename(req),
	);
	ipcMain.handle("agent:delete", async (_e, req: DeleteSessionRequest) => {
		await taskManager?.remove(req.sessionFile);
		// The transcript is gone, so nothing can reach the checkout any more —
		// leaving it would strand both the directory and its branch.
		worktrees ??= new WorktreeService(app.getPath("userData"));
		await worktrees.releaseByFile(req.sessionFile);
	});

	ipcMain.handle("worktree:status", (_e, sessionId: string): Promise<WorktreeStatus | null> => {
		worktrees ??= new WorktreeService(app.getPath("userData"));
		return worktrees.status(sessionId);
	});
	ipcMain.handle("worktree:list", (): WorktreeRecord[] => {
		worktrees ??= new WorktreeService(app.getPath("userData"));
		return worktrees.list();
	});
	// Both take a branch off the board's rows, so the board is re-sent after.
	ipcMain.handle("worktree:merge", async (_e, req: WorktreeMergeRequest): Promise<WorktreeMergeResult> => {
		worktrees ??= new WorktreeService(app.getPath("userData"));
		const result = await worktrees.merge(req);
		pushTaskBoard();
		return result;
	});
	ipcMain.handle("worktree:discard", async (_e, sessionId: string): Promise<void> => {
		worktrees ??= new WorktreeService(app.getPath("userData"));
		await worktrees.discard(sessionId);
		pushTaskBoard();
	});

	ipcMain.handle("agent:tasks", (): TaskBoardEntry[] => taskBoard());
	ipcMain.handle("agent:abortTask", (_e, sessionId: string) => {
		if (typeof sessionId !== "string") throw new Error("Invalid session id");
		return taskManager?.abortSession(sessionId);
	});
	ipcMain.handle("agent:dismissTasks", (_e, sessionIds: unknown) => {
		if (!Array.isArray(sessionIds) || !sessionIds.every((id) => typeof id === "string")) throw new Error("Invalid session ids");
		taskManager?.dismiss(sessionIds);
	});

	ipcMain.handle("mcp:list", (): McpSnapshot => {
		if (!mcpService) throw new Error("MCP service unavailable");
		return mcpService.snapshot();
	});
	ipcMain.handle("mcp:save", (_e, req: SaveMcpServerRequest): Promise<McpSnapshot> => {
		if (!mcpService) throw new Error("MCP service unavailable");
		return mcpService.save(req);
	});
	ipcMain.handle("mcp:remove", (_e, id: string): Promise<McpSnapshot> => {
		if (!mcpService) throw new Error("MCP service unavailable");
		return mcpService.remove(id);
	});
	ipcMain.handle("mcp:reconnect", (_e, id: string): Promise<McpSnapshot> => {
		if (!mcpService) throw new Error("MCP service unavailable");
		return mcpService.reconnect(id);
	});
	ipcMain.handle("mcp:signIn", (_e, id: string): Promise<McpSnapshot> => {
		if (!mcpService) throw new Error("MCP service unavailable");
		return mcpService.signIn(id);
	});
	ipcMain.handle("mcp:openDesktop", (event, id: string) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window || window.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame ||
			typeof id !== "string" || !id || id.length > 256) throw new Error("Invalid desktop request");
		if (!mcpService) throw new Error("MCP service unavailable");
		return mcpService.openDesktop(id);
	});
	ipcMain.handle("mcp:signOut", (_e, id: string): Promise<McpSnapshot> => {
		if (!mcpService) throw new Error("MCP service unavailable");
		return mcpService.signOut(id);
	});

	const acp = (): AcpService =>
		(acpService ??= new AcpService({
			clientVersion: app.getVersion(),
			store: new AcpConfigStore(app.getPath("userData")),
			appRoot: app.getAppPath(),
			toolServers: acpToolServers,
			// The same line diff NekoLocal's edit tool shows.
			textDiffer: async () => {
				const { generateDiffString } = await pi();
				return (oldText, newText) => generateDiffString(oldText, newText).diff;
			},
			proxyUrl: () => proxyService?.current().url,
			emitHistoryChanged: (agentId) => {
				for (const win of BrowserWindow.getAllWindows()) win.webContents.send("acp:historyChanged", agentId);
			},
			emitState: (state) => {
				for (const win of BrowserWindow.getAllWindows()) win.webContents.send("acp:changed", state);
			},
			emitSnapshot: (snapshot) => {
				for (const win of BrowserWindow.getAllWindows()) win.webContents.send("acp:snapshot", snapshot);
			},
		}));
	lanService?.setAcpProvider(acp);
	ipcMain.handle("acp:state", () => acp().state());
	ipcMain.handle("acp:snapshot", (_e, sessionId: string) => acp().view(sessionId));
	ipcMain.handle("acp:create", (_e, req: AcpCreateSessionRequest) => acp().create(req));
	ipcMain.handle("acp:open", (_e, req: AcpOpenSessionRequest) => acp().openHistory(req));
	ipcMain.handle("acp:history", (_e, agentId: string) => acp().history(agentId));
	ipcMain.handle("acp:saveAgent", (_e, req: AcpSaveAgentRequest) => acp().saveAgent(req));
	ipcMain.handle("acp:removeAgent", (_e, id: string) => acp().removeAgent(id));
	ipcMain.handle("acp:prompt", (_e, req: AcpPromptRequest) => acp().prompt(req));
	ipcMain.handle("acp:cancel", (_e, sessionId: string) => acp().cancel(sessionId));
	ipcMain.handle("acp:setConfig", (_e, req: AcpSetConfigRequest) => acp().setConfig(req));
	ipcMain.handle("acp:permission", (_e, res: AcpPermissionResponse) => acp().respondPermission(res));
	ipcMain.handle("acp:close", (_e, sessionId: string) => acp().close(sessionId));

	ipcMain.handle("qqbot:status", (): QqBotStatus => {
		qqBotService ??= createQqBotService();
		return qqBotService.snapshot();
	});
	ipcMain.handle("qqbot:save", (_e, config: QqBotConfig): QqBotStatus => {
		qqBotService ??= createQqBotService();
		return qqBotService.save(config);
	});
	/** Redial without an edit — what a user presses after fixing the bot backend. */
	ipcMain.handle("qqbot:reconnect", (): QqBotStatus => {
		qqBotService ??= createQqBotService();
		qqBotService.refresh();
		return qqBotService.snapshot();
	});
	ipcMain.handle("qqbot:pairing", (): QqBotStatus => {
		qqBotService ??= createQqBotService();
		return qqBotService.newPairing();
	});
	ipcMain.handle("qqbot:revoke", (_e, id: string): QqBotStatus => {
		qqBotService ??= createQqBotService();
		return qqBotService.revoke(id);
	});
	ipcMain.handle("qqbot:clearLog", (): QqBotStatus => {
		qqBotService ??= createQqBotService();
		return qqBotService.clearLog();
	});
	ipcMain.handle("qqbot:chooseProject", async (e): Promise<string | null> => {
		const win = BrowserWindow.fromWebContents(e.sender);
		if (!win) return null;
		const result = await dialog.showOpenDialog(win, {
			properties: ["openDirectory"],
			title: "允许 QQ 创建任务的项目",
		});
		return result.canceled ? null : result.filePaths[0];
	});
	ipcMain.handle("agent:snapshot", () => toWindow(taskManager?.active.getSnapshot()));
	ipcMain.handle("agent:defaults", (_e, cwd: string) =>
		taskManager?.active.getDefaults(cwd),
	);
	ipcMain.handle("agent:send", (_e, req: SendPromptRequest) =>
		taskManager?.active.send(req),
	);
	/**
	 * Run a prompt in a new session while the window stays where it is.
	 *
	 * Created unselected, so the task never steals the transcript the user is
	 * reading — it joins the sidebar with a running dot and is opened by clicking
	 * it like any other. Create and send are one round trip because a renderer
	 * that did them in two could have the selection change in between and prompt
	 * the wrong session.
	 */
	ipcMain.handle("agent:startBackground", (_e, req: StartBackgroundTaskRequest): Promise<StartBackgroundTaskResult> =>
		startBackgroundTask(req.cwd, req.text),
	);

	ipcMain.handle("preferences:get", (): AppPreferences => {
		preferences ??= new AppPreferencesStore(app.getPath("userData"));
		return preferences.get();
	});
	ipcMain.handle("preferences:update", (_e, patch: Partial<AppPreferences>): AppPreferences => {
		preferences ??= new AppPreferencesStore(app.getPath("userData"));
		const next = preferences.update(patch);
		taskNotifier?.setEnabled(next.notifyOnTaskFinish);
		// Switching it off should also end an action already under way, not only
		// keep the tools out of the next session.
		if (!next.computerUse) computerUse?.stop();
		return next;
	});
	ipcMain.handle("preferences:commandShells", (): CommandShellOption[] => listCommandShells());
	// Right-click menus in the renderer: run the command on the sender's own
	// contents, so it acts on whatever field has focus there.
	ipcMain.handle("edit:command", (event, command: EditCommand) => {
		if (!(EDIT_COMMANDS as readonly string[]).includes(command)) throw new Error(`Unknown edit command: ${command}`);
		event.sender[command]();
	});
	ipcMain.handle("fonts:list", (_e, refresh?: boolean): Promise<SystemFont[]> => listSystemFonts(refresh === true));
	ipcMain.handle("agent:abort", () => taskManager?.active.abort());
	ipcMain.handle("agent:setFusion", (_e, config: FusionConfig) => toWindow(taskManager?.active.setFusion(config)));
	ipcMain.handle("agent:setModel", (_e, modelKey: string) =>
		toWindow(taskManager?.active.setModel(modelKey)),
	);
	ipcMain.handle("agent:setThinking", (_e, level: ThinkingLevel) =>
		toWindow(taskManager?.active.setThinkingLevel(level)),
	);
	ipcMain.handle("agent:setWorkMode", (_e, mode: WorkMode) => toWindow(taskManager?.active.setWorkMode(mode)));

	ipcMain.handle("checkpoints:list", () => taskManager?.active.listCheckpoints() ?? []);
	ipcMain.handle("checkpoints:fileDiff", (_e, id: string, path: string) => {
		if (!taskManager) throw new Error("Agent service unavailable");
		return taskManager!.active.checkpointFileDiff(id, path);
	});
	ipcMain.handle("checkpoints:preview", (_e, id: string) => {
		if (!taskManager) throw new Error("Agent service unavailable");
		return taskManager!.active.previewCheckpoint(id);
	});
	ipcMain.handle("checkpoints:restore", (_e, req: RestoreCheckpointRequest) => {
		if (!taskManager) throw new Error("Agent service unavailable");
		if (req?.scope !== "code" && req?.scope !== "conversation" && req?.scope !== "both") {
			throw new Error(`Unknown checkpoint scope: ${String(req?.scope)}`);
		}
		return taskManager!.active.restoreCheckpoint(req);
	});

	ipcMain.handle("agent:answerWorkflow", (_e, answer: WorkflowAnswer) => toWindow(taskManager?.active.answerWorkflow(answer)));
	ipcMain.handle("agent:cancelTask", (_e, id: string) => toWindow(taskManager?.active.cancelTask(id)));
	const pluginCatalog = new PluginCatalogService();
	ipcMain.handle("plugins:catalog", (_event, query: PluginCatalogQuery) => pluginCatalog.list(query));
	ipcMain.handle("plugins:list", () => taskManager?.active.pluginsSnapshot());
	/** Run a plugin change in the session on screen, then bring every other open one up to date. */
	const pluginChange = async <T>(action: (agent: AgentService) => Promise<T>): Promise<T | undefined> => {
		const manager = taskManager;
		if (!manager) return undefined;
		const agent = manager.active;
		const result = await action(agent);
		manager.reloadPlugins(agent);
		return result;
	};
	ipcMain.handle("plugins:install", (_e, request: InstallPluginRequest) =>
		pluginChange((agent) => agent.installPlugin(request)),
	);
	ipcMain.handle("plugins:remove", (_e, request: PluginActionRequest) =>
		pluginChange((agent) => agent.removePlugin(request)),
	);
	ipcMain.handle("plugins:update", (_e, source?: string) => pluginChange((agent) => agent.updatePlugin(source)));
	ipcMain.handle("plugins:setEnabled", (_e, request: SetPluginEnabledRequest) =>
		pluginChange((agent) => agent.setPluginEnabled(request)),
	);
	ipcMain.handle("agent:answerExtensionUi", (_e, sessionId: string, answer: ExtensionUiAnswer) =>
		taskManager?.answerExtensionUi(sessionId, answer) ?? null,
	);
	ipcMain.handle("agent:setMode", (_e, mode: ExecutionMode) =>
		toWindow(taskManager?.active.setMode(mode)),
	);

	ipcMain.handle("terminal:create", (_e, req: TerminalCreateRequest) =>
		terminalService?.create(req),
	);
	ipcMain.handle("terminal:input", (_e, req: TerminalInputRequest) =>
		terminalService?.write(req),
	);
	ipcMain.handle("terminal:resize", (_e, req: TerminalResizeRequest) =>
		terminalService?.resize(req),
	);
	ipcMain.handle("terminal:kill", (_e, id: string) => terminalService?.kill(id));

	ipcMain.handle("settings:modelStatus", () => modelConfig?.status());
	ipcMain.handle("settings:listModels", () => modelConfig?.list());
	ipcMain.handle("settings:saveModel", async (_e, req: SaveModelProfileRequest) => {
		const summary = modelConfig?.save(req);
		await taskManager?.reloadModels();
		return summary;
	});
	ipcMain.handle("settings:deleteModel", async (_e, id: string) => {
		modelConfig?.delete(id);
		await taskManager?.reloadModels();
	});
	ipcMain.handle("settings:fetchModels", (_e, req: FetchModelsRequest) =>
		modelConfig?.fetchModels(req),
	);
	ipcMain.handle("settings:testModel", (_e, req: ModelTestRequest) =>
		taskManager?.active.testConfiguredModel(req),
	);

	// Read straight off the open session's loaders, so the composer's menu can
	// be fetched on every open rather than pushed and cached in the renderer.
	ipcMain.handle("agent:commands", () => taskManager?.active.slashCommands() ?? []);

	ipcMain.handle("agent:goal", (_e, action: GoalAction) => toWindow(taskManager?.active.goalAction(action)));
	ipcMain.handle("agent:mentions", (_e, query: string, cwd?: string) =>
		taskManager?.active.mentionSearch(query, typeof cwd === "string" ? cwd : undefined) ?? [],
	);

	ipcMain.handle("instructions:read", (_e, cwd: string) => {
		if (typeof cwd !== "string" || !cwd) throw new Error("请先选择项目目录");
		return readProjectInstructions(cwd);
	});
	ipcMain.handle("instructions:save", async (_e, request: SaveInstructionsRequest) => {
		const result = await saveProjectInstructions(request);
		// Every open session, not just this project's: the global file is in all of them.
		await taskManager?.reloadContext();
		return result;
	});

	ipcMain.handle("memory:list", () => ({ entries: memoryStore().list() }));
	ipcMain.handle("memory:save", (_e, request: SaveMemoryRequest) => {
		memoryStore().save(request, "user");
		return { entries: memoryStore().list() };
	});
	ipcMain.handle("memory:remove", (_e, id: string) => {
		memoryStore().remove(id);
		return { entries: memoryStore().list() };
	});

	ipcMain.handle("hooks:list", () => hookService().snapshot());
	ipcMain.handle("hooks:save", (_e, request: SaveHookRequest) => hookService().save(request));
	ipcMain.handle("hooks:remove", (_e, id: string) => hookService().remove(id));
	ipcMain.handle("hooks:clearRecent", () => hookService().clearRecent());

	ipcMain.handle("skills:list", () => taskManager?.active.skillsSnapshot());
	ipcMain.handle("themes:list", () => themeLibrary().snapshot());
	ipcMain.handle("themes:install", (_e, source: string) => {
		if (typeof source !== "string") throw new Error("主题包内容无效");
		return themeLibrary().install(source);
	});
	ipcMain.handle("themes:chooseDirectory", async (e): Promise<string | null> => {
		const win = BrowserWindow.fromWebContents(e.sender);
		if (!win) return null;
		const result = await dialog.showOpenDialog(win, {
			properties: ["openDirectory"],
			title: "选择主题文件夹",
		});
		return result.canceled ? null : result.filePaths[0] ?? null;
	});
	ipcMain.handle("themes:installDirectory", (_e, sourceDir: string) => {
		if (typeof sourceDir !== "string") throw new Error("主题文件夹路径无效");
		return themeLibrary().installDirectory(sourceDir);
	});
	ipcMain.handle("themes:art", (_e, id: string) => themeLibrary().art(id));
	ipcMain.handle("themes:remove", (_e, id: string) => themeLibrary().remove(id));
	ipcMain.handle("themes:openDir", async () => {
		const { dir } = themeLibrary();
		mkdirSync(dir, { recursive: true });
		const error = await shell.openPath(dir);
		if (error) throw new Error(error);
	});
	ipcMain.handle("skills:setEnabled", (_e, request: SetSkillEnabledRequest) =>
		taskManager?.active.setSkillEnabled(request),
	);
	// A skill written or copied here sits in a directory every session loads
	// from, so every open session reloads — the same as an instructions file.
	ipcMain.handle("skills:create", async (_e, request: CreateSkillRequest) => {
		if (!taskManager) return null;
		await taskManager.active.createSkill(request);
		await taskManager.reloadContext();
		return taskManager.active.skillsSnapshot();
	});
	ipcMain.handle("skills:scanImport", (_e, request: ScanSkillImportRequest) =>
		taskManager?.active.scanSkillImport(request),
	);
	ipcMain.handle("skills:import", async (_e, request: ImportSkillsRequest): Promise<ImportSkillsResult | null> => {
		if (!taskManager) return null;
		const result = await taskManager.active.importSkills(request);
		if (result.imported.length) await taskManager.reloadContext();
		return { ...result, snapshot: await taskManager.active.skillsSnapshot() };
	});
	ipcMain.handle("skills:remove", async (_e, request: RemoveSkillRequest) => {
		if (!taskManager) return null;
		await taskManager.active.removeSkill(request);
		await taskManager.reloadContext();
		return taskManager.active.skillsSnapshot();
	});

	ipcMain.handle("stats:tokens", async () => {
		await freshPrices();
		return tokenStatsService().report();
	});
	// A full re-parse, for when the numbers are doubted rather than merely stale —
	// prices included.
	ipcMain.handle("stats:rescanTokens", async () => {
		await freshPrices(true);
		tokenStatsService().reset();
		return tokenStatsService().report();
	});
	ipcMain.handle("stats:exportTokens", async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return null;
		await freshPrices();
		const report = await tokenStatsService().report();
		const stamp = new Date().toISOString().slice(0, 10);
		const result = await dialog.showSaveDialog(win, {
			title: "导出 Token 统计",
			defaultPath: join(app.getPath("downloads"), `nekocode-tokens-${stamp}.csv`),
			filters: [{ name: "CSV", extensions: ["csv"] }],
		});
		if (result.canceled || !result.filePath) return null;
		// A BOM so Excel opens the file as UTF-8 rather than mojibake — session
		// titles and workspace paths are routinely not ASCII.
		await writeFile(result.filePath, `﻿${tokenUsageCsv(report)}`, "utf8");
		return result.filePath;
	});

	ipcMain.handle("settings:proxyStatus", () => proxyService?.current());
	ipcMain.handle("settings:saveProxy", (_e, manual: string | null) => proxyService?.save(manual));
	ipcMain.handle("settings:webToolsStatus", async () => ({ ...webTools().status(), accounts: await webSearchAccounts() }));
	ipcMain.handle("codeIntel:status", () => codeIntel().status());
	ipcMain.handle("codeIntel:save", (_e, patch: CodeIntelUpdate) => {
		const status = codeIntel().update(patch ?? {});
		// Sessions pick the tool up or drop it on their next model call.
		if (patch?.indexEnabled !== undefined) taskManager?.refreshPrompts();
		return status;
	});
	ipcMain.handle("codeIntel:indexStatus", (_e, cwd: string) => {
		const service = semanticIndexService();
		if (codeIntel().status().indexEnabled) service.warm(cwd);
		return service.status(cwd);
	});
	// The models code intelligence can pick from, without touching the agent's own state.
	ipcMain.handle("codeIntel:models", async (): Promise<CodeIntelModels> => {
		// Custom API providers from their saved profiles; accounts from the runtime,
		// once any refresh in flight has settled.
		const profiles = (modelConfig?.list() ?? []).filter((profile) => profile.kind === "custom-api");
		const runtime = await taskManager?.active.getModelRuntime().catch(() => null);
		const available = runtime ? await runtime.getAvailable().catch(() => runtime.getAvailableSnapshot()) : [];
		return {
			chat: codeIntelModelList(profiles, available, (provider) => runtime?.getProvider(provider)?.name ?? provider),
		};
	});
	ipcMain.handle("codeIntel:rebuild", (_e, cwd: string) => semanticIndexService().rebuild(cwd));
	ipcMain.handle("codeIntel:complete", (_e, request: CompletionRequest) => tabCompletionService().complete(request));
	ipcMain.handle("codeIntel:cancelComplete", (_e, id: string) => tabCompletion?.cancel(id));
	ipcMain.handle("settings:saveWebTools", async (_e, patch: WebToolsUpdate) => ({
		...webTools().update(patch ?? {}),
		accounts: await webSearchAccounts(),
	}));
	// The default prompt's text is never sent: the page only lists the user's own.
	ipcMain.handle("prompts:list", () => prompts().snapshot());
	// Open sessions rebuild their system prompt at once, so the next model call
	// already uses what changed.
	const changedPrompts = (snapshot: PromptsSnapshot) => {
		taskManager?.refreshPrompts();
		return snapshot;
	};
	ipcMain.handle("prompts:save", (_e, request: SavePromptRequest) => changedPrompts(prompts().save(request)));
	ipcMain.handle("prompts:remove", (_e, id: unknown) => {
		if (typeof id !== "string") throw new Error("Invalid prompt id");
		return changedPrompts(prompts().remove(id));
	});
	ipcMain.handle("prompts:setActive", (_e, id: unknown) => {
		if (id !== null && typeof id !== "string") throw new Error("Invalid prompt id");
		return changedPrompts(prompts().setActive(id));
	});
	ipcMain.handle("web:favicon", (_e, url: unknown) => (typeof url === "string" ? faviconFor(url) : null));

	ipcMain.handle("oauth:list", () => oauthService?.list());
	ipcMain.handle("oauth:refresh", (_e, id: string) => oauthService?.refresh(id));
	ipcMain.handle("oauth:login", async (_e, id: string, options?: OAuthLoginOptions) => {
		if (!oauthService) throw new Error("OAuth service unavailable");
		const account = await oauthService.login(id, oauthLoginOptions(options));
		// The provider only becomes selectable once its models are registered.
		await taskManager?.reloadModels();
		return account;
	});
	ipcMain.handle("oauth:usage", (_e, id: string, force?: boolean) => {
		if (!oauthService) throw new Error("OAuth service unavailable");
		return oauthService.usage(id, force === true);
	});
	ipcMain.handle("oauth:cancel", (_e, id: string) => oauthService?.cancel(id));
	ipcMain.handle("oauth:submitCode", (_e, id: string, code: string) =>
		oauthService?.submitCode(id, code),
	);
	ipcMain.handle("oauth:logout", async (_e, id: string) => {
		if (!oauthService) throw new Error("OAuth service unavailable");
		const account = await oauthService.logout(id);
		await taskManager?.reloadModels();
		return account;
	});

	ipcMain.handle("github:status", () => githubAuth?.status());
	ipcMain.handle("github:save", (_e, token: string) => {
		if (!githubAuth) throw new Error("GitHub auth service unavailable");
		return githubAuth.save(token);
	});
	ipcMain.handle("github:clear", () => githubAuth?.clear());

	ipcMain.handle("ssh:status", () => ssh().store.status());
	ipcMain.handle("ssh:save", (_e, input: unknown) => {
		const { store, service } = ssh();
		const status = store.save(input);
		// An edit may change where or as whom it connects; the pooled link is stale either way.
		const id = (input as { id?: unknown } | null)?.id;
		if (typeof id === "string") {
			service.disconnect(id);
			remoteDesktops?.disconnect(id);
		}
		return status;
	});
	ipcMain.handle("ssh:remove", (_e, id: string) => {
		ssh().service.disconnect(id);
		remoteDesktops?.disconnect(id);
		return ssh().store.remove(id);
	});

	ipcMain.handle("desktop:states", () => remoteDesktops?.states() ?? []);
	// Opened from the panel, the user is the one who wants to drive it.
	ipcMain.handle("desktop:connect", (_e, hostId: string) => desktops().connect(hostId, "user"));
	ipcMain.handle("desktop:disconnect", (_e, hostId: string) => remoteDesktops?.disconnect(hostId));
	ipcMain.handle("desktop:setController", (_e, hostId: string, controller: DesktopController) => {
		if (controller !== "agent" && controller !== "user") throw new Error("Invalid controller");
		return desktops().setController(hostId, controller);
	});
	ipcMain.handle("desktop:watch", (_e, hostId: string, watching: boolean) => remoteDesktops?.watch(hostId, !!watching));
	// Fire-and-forget: pointer motion arrives dozens of times a second.
	ipcMain.on("desktop:pointer", (_e, input: DesktopPointerInput) => {
		try {
			remoteDesktops?.userPointer(input);
		} catch {
			// Closed under the pointer; the state event already says so.
		}
	});
	ipcMain.on("desktop:key", (_e, input: DesktopKeyInput) => {
		try {
			remoteDesktops?.userKey(input);
		} catch {}
	});
	ipcMain.handle("ssh:test", (_e, id: string) => ssh().service.test(id));
	ipcMain.handle("ssh:chooseKey", async (e): Promise<string | null> => {
		const win = BrowserWindow.fromWebContents(e.sender);
		if (!win) return null;
		const sshDir = join(app.getPath("home"), ".ssh");
		const result = await dialog.showOpenDialog(win, {
			properties: ["openFile", "showHiddenFiles"],
			title: "选择 SSH 私钥",
			...(existsSync(sshDir) ? { defaultPath: sshDir } : {}),
		});
		return result.canceled ? null : result.filePaths[0];
	});
	ipcMain.handle("ssh:forgetHostKey", (_e, id: string) => {
		ssh().service.disconnect(id);
		return ssh().store.setFingerprint(id, null);
	});

	ipcMain.handle("pr:list", (_e, cwd: string, filter: PullRequestFilter) =>
		pullRequests?.list(cwd, filter),
	);
	ipcMain.handle("pr:detail", (_e, cwd: string, number: number) =>
		pullRequests?.detail(cwd, number),
	);
	ipcMain.handle("pr:branches", (_e, cwd: string) => pullRequests?.branches(cwd));
	ipcMain.handle("pr:create", (_e, req: CreatePullRequestRequest) =>
		pullRequests?.create(req),
	);

	ipcMain.handle("automation:list", () => automationService?.list() ?? []);
	ipcMain.handle("automation:get", (_e, id: string) => automationService?.get(id) ?? null);
	ipcMain.handle("automation:runs", (_e, id: string) => automationService?.runs(id) ?? []);
	ipcMain.handle("automation:save", (_e, req: SaveAutomationRequest) => {
		if (!automationService) throw new Error("Automation service unavailable");
		return automationService.save(req);
	});
	ipcMain.handle("automation:remove", (_e, id: string) => automationService?.remove(id));
	ipcMain.handle("automation:runNow", (_e, id: string) => {
		if (!automationService) throw new Error("Automation service unavailable");
		return automationService.runNow(id);
	});
	ipcMain.handle("automation:abort", (_e, id: string) => automationService?.abort(id));

	ipcMain.handle("webui:status", () => webUiService?.status());
	ipcMain.handle("webui:save", (_e, request: SaveWebUiConfigRequest) => {
		if (!webUiService) throw new Error("WebUI service unavailable");
		return webUiService.save(request);
	});

	ipcMain.on("webui:ready", (event) => {
		if (webUiBridge && webUiBridge !== event.sender) webUiBridgeGone(webUiBridge);
		webUiBridge = event.sender;
		for (const [id, pending] of webUiPending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("WebUI bridge reloaded"));
			webUiPending.delete(id);
		}
	});
	ipcMain.on("webui:rpcResult", (event, response: unknown) => {
		if (event.sender !== webUiBridge || !isWebUiBridgeResponse(response)) return;
		const pending = webUiPending.get(response.id);
		if (!pending) return;
		webUiPending.delete(response.id);
		clearTimeout(pending.timer);
		if (response.ok) pending.resolve(response.value);
		else pending.reject(new Error(response.error));
	});
	ipcMain.on("webui:event", (event, channel: unknown, payload: unknown) => {
		if (event.sender !== webUiBridge || !isWebUiEventChannel(channel)) return;
		webUiService?.broadcast(channel, payload);
	});
}

/** How long startup waits for the proxy before showing a window regardless. */
const PROXY_STARTUP_TIMEOUT_MS = 3000;

app.whenReady().then(async () => {
	// Before anything touches safeStorage: over remote desktop the keyring
	// Chromium picked is often unreachable, and only a relaunch can switch.
	const keyring = settleLinuxKeyring(safeStorage, app);
	if (keyring === "relaunching") return;
	// Before any session is made: every prompt it builds reads the user's replacements.
	configureCustomPrompt(() => prompts().activeContent());
	configureSemanticSearch({
		enabled: () => codeIntel().status().indexEnabled,
		service: () => semanticIndexService(),
	});
	if (keyring === "basic_text") console.warn("No system keyring this session; secrets use Electron's local key.");
	if (process.platform === "darwin") app.dock?.setIcon(appIconPng);
	if (process.platform !== "darwin") Menu.setApplicationMenu(null);
	try {
		// Before anything reads the agent home: the kernel is branded to
		// ~/.nekocode, and an existing ~/.pi home has to come with it.
		const migration = migrateAgentHome();
		if (migration === "migrated") console.log("Carried the agent home over from ~/.pi/agent.");
	} catch (error) {
		// A failed copy is not a reason to refuse to start — the app comes up on
		// a fresh home, and the old one is still where it was.
		console.error("Could not carry the agent home over from ~/.pi/agent:", error);
	}
	try {
		// Watched from now on: the agent's shells inherit the folder's path, and
		// a package it downloads there is installed and applied without a restart.
		const themes = themeLibrary();
		process.env[THEMES_DIR_ENV] = themes.dir;
		themes.onChange((change) => {
			for (const window of BrowserWindow.getAllWindows())
				if (!window.isDestroyed()) window.webContents.send("themes:changed", change);
		});
		themes.start();
	} catch (error) {
		console.error("Could not watch the community themes folder:", error);
	}
	// Before the first provider request: without this the agent core connects
	// direct regardless of what the rest of the machine is proxied through.
	proxyService = new ProxyService({
		userDataDir: app.getPath("userData"),
		resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
	});
	const proxyReady = proxyService
		.refresh()
		.then((status) => {
			if (status.url) console.log(`Outgoing requests use the ${status.source} proxy ${status.url}.`);
			if (status.warning) console.warn(`Proxy: ${status.warning}`);
		})
		.catch((error: unknown) => console.error("Could not apply the proxy settings:", error));
	// Waited for, so nothing can go out direct before it lands — but only so
	// long: resolving a system proxy can mean fetching a PAC script, and a
	// window that never opens is worse than a first request that missed it.
	await Promise.race([proxyReady, new Promise((resolve) => setTimeout(resolve, PROXY_STARTUP_TIMEOUT_MS))]);

	registerIpc();
	// Before the window exists: the shell material is a window-construction
	// option, so a preference saved last run has to be known by now.
	windowMaterialStore = new WindowMaterialStore(app.getPath("userData"));
	activeMaterial = windowMaterialStore.resolve(supportedMaterials);
	webUiService = new WebUiService({
		userDataDir: app.getPath("userData"),
		rendererDir: join(__dirname, "../renderer"),
		rendererDevUrl: process.env.ELECTRON_RENDERER_URL,
		homeDir: app.getPath("home"),
		shell: { material: "opaque", materials: ["opaque"], titleBarHeight: TITLE_BAR_HEIGHT },
		invoke: webUiInvoke,
	});
	createWindow();
	void webUiService.startConfigured().catch((error: unknown) =>
		console.error("Could not start the WebUI server:", error),
	);
	// After the proxy is in place: the price list is fetched through it.
	modelPricingService().start();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("before-quit", () => {
	void webUiService?.stop();
	modelPricing?.stop();
	automationService?.stop();
	terminalService?.killAll();
	remoteDesktops?.disconnectAll();
	sshState?.service.disconnectAll();
	// Clone dev servers are child processes the agent started and may not have stopped.
	devServers.stopAll();
	// Stdio servers are child processes: not killing them leaks one per launch.
	mcpService?.close();
	acpService?.dispose();
	toolServer?.close();
	computerUse?.dispose();
	semanticIndex?.dispose();
	qqBotService?.close();
	relayService?.close();
	relayService = null;
	taskManager?.close(); void lanService?.stop();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
