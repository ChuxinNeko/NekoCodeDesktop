import type { FastContextConfig } from "../shared/fast-context";
import type { FusionConfig } from "../shared/fusion";
import type { LanStatus } from "../shared/lan";
import type { AppVersionInfo, UpdateCheckResult } from "../shared/updates";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { DEFAULT_SHELL_INFO, type ShellInfo, type WindowMaterial } from "../shared/window";
import type {
	InstallPluginRequest,
	PluginActionRequest,
	PluginCatalogQuery,
	PluginCatalogPage,
	PluginsSnapshot,
	SetPluginEnabledRequest,
} from "../shared/plugins";
import type { WorkMode, WorkflowAnswer } from "../shared/workflow";
import type { AutomationEvent, AutomationRun, AutomationWithState, SaveAutomationRequest } from "../shared/automation";
import type { BrowserPopupRequest, BrowserPreviewRequest, BrowserElementSelection } from "../shared/browser";
import type {
	CreatePullRequestRequest,
	GitHubAuthStatus,
	PullRequestDetail,
	PullRequestFilter,
	PullRequestListResult,
	PullRequestSummary,
	RepositoryBranch,
} from "../shared/pullRequests";
import type {
	AgentDefaults,
	AgentSnapshot,
	DeleteSessionRequest,
	ExecutionMode,
	OpenSessionRequest,
	RenameSessionRequest,
	SendPromptRequest,
	SendPromptResult,
	SessionSummary,
	StartBackgroundTaskRequest,
	StartBackgroundTaskResult,
	ThinkingLevel,
} from "../shared/agent";
import type { SlashCommandSummary } from "../shared/commands";
import type { FsEntry, FsReadResult, HostDirectoryListing } from "../shared/files";
import type { MentionCandidate } from "../shared/mentions";
import type { GoalAction } from "../shared/goal";
import type { ProjectInstructions, SaveInstructionsRequest } from "../shared/instructions";
import type { MemorySnapshot, SaveMemoryRequest } from "../shared/memory";
import type { HooksSnapshot, SaveHookRequest } from "../shared/hooks";
import type { SetSkillEnabledRequest, SkillsSnapshot } from "../shared/skills";
import type { AppPreferences } from "../shared/preferences";
import type {
	WorktreeMergeRequest,
	WorktreeMergeResult,
	WorktreeRecord,
	WorktreeStatus,
} from "../shared/worktree";
import type { McpSnapshot, SaveMcpServerRequest } from "../shared/mcp";
import type {
	AcpAgentInfo,
	AcpCreateSessionRequest,
	AcpHistory,
	AcpOpenSessionRequest,
	AcpPermissionResponse,
	AcpPromptRequest,
	AcpSaveAgentRequest,
	AcpSessionSnapshot,
	AcpSetConfigRequest,
	AcpState,
} from "../shared/acp";
import type { QqBotConfig, QqBotStatus } from "../shared/qqbot";
import type {
	RelayLoginRequest,
	RelayRegisterRequest,
	RelayResendRequest,
	RelayStatus,
	RelayVerifyRequest,
} from "../shared/relay";
import {
	WEBUI_EVENT_CHANNELS,
	isWebUiRpcMethod,
	type SaveWebUiConfigRequest,
	type WebUiBridgeRequest,
	type WebUiStatus,
} from "../shared/webui";
import type { TokenUsageReport } from "../shared/tokenStats";
import type {
	CheckpointFileDiff,
	CheckpointPreview,
	CheckpointSummary,
	RestoreCheckpointRequest,
	RestoreCheckpointResult,
} from "../shared/checkpoints";
import type { GitActionRequest, GitDiffRequest, ReviewScope } from "../shared/git";
import type {
	TerminalCreateRequest,
	TerminalExit,
	TerminalInputRequest,
	TerminalOutput,
	TerminalResizeRequest,
	TerminalSession,
} from "../shared/terminal";
import type {
	FetchModelsRequest,
	FetchedModel,
	ModelProfileSummary,
	ModelStoreStatus,
	ModelTestRequest,
	ModelTestResult,
	OAuthLoginEvent,
	OAuthProviderId,
	OAuthProviderSummary,
	ProxyStatus,
	SaveModelProfileRequest,
} from "../shared/settings";

function subscribe<T>(
	channel: string,
	listener: (payload: T) => void,
): () => void {
	const wrapped = (_e: IpcRendererEvent, payload: T) => listener(payload);
	ipcRenderer.on(channel, wrapped);
	return () => ipcRenderer.removeListener(channel, wrapped);
}

// Read once, synchronously: the theme module applies CSS variables at import
// time, well before any promise from the bridge could resolve.
const shellInfo: ShellInfo =
	(ipcRenderer.sendSync("app:shellInfo") as ShellInfo | undefined) ?? DEFAULT_SHELL_INFO;

const api = {
	runtime: "electron" as const,
	webUiStatus: (): Promise<WebUiStatus> => ipcRenderer.invoke("webui:status"),
	webUiSave: (request: SaveWebUiConfigRequest): Promise<WebUiStatus> =>
		ipcRenderer.invoke("webui:save", request),
	lanStatus: (): Promise<LanStatus> => ipcRenderer.invoke("lan:status"),
	lanSetEnabled: (enabled: boolean): Promise<LanStatus> => ipcRenderer.invoke("lan:enabled", enabled),
	lanPairing: (): Promise<LanStatus> => ipcRenderer.invoke("lan:pairing"),
	lanRevoke: (id: string): Promise<LanStatus> => ipcRenderer.invoke("lan:revoke", id),
	lanAddProject: (): Promise<LanStatus> => ipcRenderer.invoke("lan:addProject"),
	lanRemoveProject: (id: string): Promise<LanStatus> => ipcRenderer.invoke("lan:removeProject", id),
	relayStatus: (): Promise<RelayStatus> => ipcRenderer.invoke("relay:status"),
	relayLogin: (request: RelayLoginRequest): Promise<RelayStatus> => ipcRenderer.invoke("relay:login", request),
	relayRegister: (request: RelayRegisterRequest): Promise<void> => ipcRenderer.invoke("relay:register", request),
	relayVerify: (request: RelayVerifyRequest): Promise<RelayStatus> => ipcRenderer.invoke("relay:verify", request),
	relayResend: (request: RelayResendRequest): Promise<void> => ipcRenderer.invoke("relay:resend", request),
	relayLogout: (): Promise<RelayStatus> => ipcRenderer.invoke("relay:logout"),
	relayReconnect: (): Promise<RelayStatus> => ipcRenderer.invoke("relay:reconnect"),
	onRelayChanged: (listener: (status: RelayStatus) => void) => subscribe("relay:changed", listener),
	appVersion: (): Promise<AppVersionInfo> => ipcRenderer.invoke("app:version"),
	checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke("app:checkForUpdates"),
	checkForUpdatesOnStartup: (): Promise<UpdateCheckResult | null> => ipcRenderer.invoke("app:checkForUpdatesOnStartup"),
	dismissStartupUpdate: (): Promise<void> => ipcRenderer.invoke("app:dismissStartupUpdate"),
	/** Window chrome the renderer has to lay out around (caption strip, backdrop). */
	shell: shellInfo,
	/** The user's home directory — the working directory a fresh install starts in. */
	homeDir: (ipcRenderer.sendSync("app:homeDir") as string | undefined) ?? "",

	initialProjectDir: (): Promise<string | null> =>
		ipcRenderer.invoke("app:initialProjectDir"),

	openExternal: (url: string): Promise<void> =>
		ipcRenderer.invoke("browser:openExternal", url),
	onBrowserPopup: (listener: (request: BrowserPopupRequest) => void) =>
		subscribe("browser:popup", listener),

	onBrowserPreview: (listener: (request: BrowserPreviewRequest) => void) => subscribe("browser:preview", listener),
	onBrowserElementSelected: (listener: (selection: BrowserElementSelection) => void) => subscribe("browser:elementSelected", listener),
	onBrowserInspectStopped: (listener: (state: { guestId: number }) => void) => subscribe("browser:inspectStopped", listener),
	onBrowserRevealAutomation: (listener: (state: { guestId: number }) => void) => subscribe("browser:revealAutomation", listener),
	browserSetInspect: (guestId: number, enabled: boolean): Promise<void> => ipcRenderer.invoke("browser:setInspect", guestId, enabled),
	browserBindAutomation: (requestId: string, guestId: number): Promise<void> =>
		ipcRenderer.invoke("browser:bindAutomation", requestId, guestId),

	setTheme: (theme: "light" | "dark" | "system") =>
		ipcRenderer.invoke("theme:set", theme),

	/** Applies a system window material; resolves with the shell it left behind. */
	setWindowMaterial: (material: WindowMaterial): Promise<ShellInfo> =>
		ipcRenderer.invoke("window:setMaterial", material),

	gitStatus: (cwd: string) => ipcRenderer.invoke("git:status", cwd),
	gitDiff: (req: GitDiffRequest) => ipcRenderer.invoke("git:diff", req),
	gitFiles: (cwd: string, scope: ReviewScope) =>
		ipcRenderer.invoke("git:files", cwd, scope),
	gitAction: (req: GitActionRequest) => ipcRenderer.invoke("git:action", req),
	gitInit: (cwd: string) => ipcRenderer.invoke("git:init", cwd),

	fsList: (cwd: string, relPath: string): Promise<FsEntry[]> =>
		ipcRenderer.invoke("fs:list", cwd, relPath),
	fsReadFile: (cwd: string, relPath: string): Promise<FsReadResult> =>
		ipcRenderer.invoke("fs:readFile", cwd, relPath),
	pickDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
	directoryList: (path: string): Promise<HostDirectoryListing> =>
		ipcRenderer.invoke("directory:list", path),
	lanAddProjectPath: (path: string): Promise<LanStatus> =>
		ipcRenderer.invoke("lan:addProjectPath", path),

	/** Pause, resume or clear the open session's `/goal`. */
	agentGoal: (action: GoalAction): Promise<AgentSnapshot | null> => ipcRenderer.invoke("agent:goal", action),
	agentMentions: (query: string, cwd?: string): Promise<MentionCandidate[]> =>
		ipcRenderer.invoke("agent:mentions", query, cwd),
	instructionsRead: (cwd: string): Promise<ProjectInstructions> => ipcRenderer.invoke("instructions:read", cwd),
	instructionsSave: (request: SaveInstructionsRequest): Promise<ProjectInstructions> =>
		ipcRenderer.invoke("instructions:save", request),
	memoryList: (): Promise<MemorySnapshot> => ipcRenderer.invoke("memory:list"),
	memorySave: (request: SaveMemoryRequest): Promise<MemorySnapshot> => ipcRenderer.invoke("memory:save", request),
	memoryRemove: (id: string): Promise<MemorySnapshot> => ipcRenderer.invoke("memory:remove", id),
	/** The agent saves memories on its own, mid-run. */
	onMemoryChanged: (listener: (snapshot: MemorySnapshot) => void) => subscribe("memory:changed", listener),
	hooksList: (): Promise<HooksSnapshot> => ipcRenderer.invoke("hooks:list"),
	hooksSave: (request: SaveHookRequest): Promise<HooksSnapshot> => ipcRenderer.invoke("hooks:save", request),
	hooksRemove: (id: string): Promise<HooksSnapshot> => ipcRenderer.invoke("hooks:remove", id),
	hooksClearRecent: (): Promise<HooksSnapshot> => ipcRenderer.invoke("hooks:clearRecent"),
	/** Every tool call can add a run to the log. */
	onHooksChanged: (listener: (snapshot: HooksSnapshot) => void) => subscribe("hooks:changed", listener),

	sessionList: (cwd?: string): Promise<SessionSummary[]> =>
		ipcRenderer.invoke("agent:listSessions", cwd),
	sessionRename: (req: RenameSessionRequest): Promise<void> =>
		ipcRenderer.invoke("agent:rename", req),
	sessionDelete: (req: DeleteSessionRequest): Promise<void> =>
		ipcRenderer.invoke("agent:delete", req),
	onSessionsChanged: (listener: () => void) =>
		subscribe("agent:sessionsChanged", listener),

	agentCreate: (cwd: string): Promise<AgentSnapshot> =>
		ipcRenderer.invoke("agent:create", cwd),
	agentOpen: (req: OpenSessionRequest): Promise<AgentSnapshot> =>
		ipcRenderer.invoke("agent:open", req),
	agentSnapshot: (): Promise<AgentSnapshot | null> =>
		ipcRenderer.invoke("agent:snapshot"),
	agentLoadEarlier: (): Promise<AgentSnapshot | null> =>
		ipcRenderer.invoke("agent:loadEarlier"),
	agentToolOutput: (toolCallId: string, offset: number): Promise<{ text: string; offset: number; total: number } | null> =>
		ipcRenderer.invoke("agent:toolOutput", toolCallId, offset),
	agentSend: (req: SendPromptRequest): Promise<SendPromptResult> =>
		ipcRenderer.invoke("agent:send", req),
	agentStartBackground: (req: StartBackgroundTaskRequest): Promise<StartBackgroundTaskResult> =>
		ipcRenderer.invoke("agent:startBackground", req),
	/** A finished task's notification was clicked: bring that session up. */
	onRevealSession: (listener: (session: SessionSummary) => void) =>
		subscribe("agent:revealSession", listener),
	preferencesGet: (): Promise<AppPreferences> => ipcRenderer.invoke("preferences:get"),
	preferencesUpdate: (patch: Partial<AppPreferences>): Promise<AppPreferences> =>
		ipcRenderer.invoke("preferences:update", patch),

	/** Null when this session works in the project directory like any other. */
	worktreeStatus: (sessionId: string): Promise<WorktreeStatus | null> =>
		ipcRenderer.invoke("worktree:status", sessionId),
	worktreeList: (): Promise<WorktreeRecord[]> => ipcRenderer.invoke("worktree:list"),
	worktreeMerge: (req: WorktreeMergeRequest): Promise<WorktreeMergeResult> =>
		ipcRenderer.invoke("worktree:merge", req),
	worktreeDiscard: (sessionId: string): Promise<void> =>
		ipcRenderer.invoke("worktree:discard", sessionId),

	mcpList: (): Promise<McpSnapshot> => ipcRenderer.invoke("mcp:list"),
	mcpSave: (req: SaveMcpServerRequest): Promise<McpSnapshot> => ipcRenderer.invoke("mcp:save", req),
	mcpRemove: (id: string): Promise<McpSnapshot> => ipcRenderer.invoke("mcp:remove", id),
	mcpReconnect: (id: string): Promise<McpSnapshot> => ipcRenderer.invoke("mcp:reconnect", id),
	/** Connection states move on their own — a server can drop at any time. */
	onMcpChanged: (listener: (snapshot: McpSnapshot) => void) => subscribe("mcp:changed", listener),
	acpState: (): Promise<AcpState> => ipcRenderer.invoke("acp:state"),
	acpSnapshot: (sessionId: string): Promise<AcpSessionSnapshot | null> => ipcRenderer.invoke("acp:snapshot", sessionId),
	acpCreate: (request: AcpCreateSessionRequest): Promise<AcpSessionSnapshot> => ipcRenderer.invoke("acp:create", request),
	acpOpen: (request: AcpOpenSessionRequest): Promise<AcpSessionSnapshot> => ipcRenderer.invoke("acp:open", request),
	acpHistory: (agentId: string): Promise<AcpHistory> => ipcRenderer.invoke("acp:history", agentId),
	acpSaveAgent: (request: AcpSaveAgentRequest): Promise<AcpAgentInfo[]> => ipcRenderer.invoke("acp:saveAgent", request),
	acpRemoveAgent: (id: string): Promise<AcpAgentInfo[]> => ipcRenderer.invoke("acp:removeAgent", id),
	onAcpHistoryChanged: (listener: (agentId: string) => void) => subscribe("acp:historyChanged", listener),
	acpPrompt: (request: AcpPromptRequest): Promise<void> => ipcRenderer.invoke("acp:prompt", request),
	acpCancel: (sessionId: string): Promise<void> => ipcRenderer.invoke("acp:cancel", sessionId),
	acpSetConfig: (request: AcpSetConfigRequest): Promise<void> => ipcRenderer.invoke("acp:setConfig", request),
	acpRespondPermission: (response: AcpPermissionResponse): Promise<void> => ipcRenderer.invoke("acp:permission", response),
	acpClose: (sessionId: string): Promise<void> => ipcRenderer.invoke("acp:close", sessionId),
	onAcpChanged: (listener: (state: AcpState) => void) => subscribe("acp:changed", listener),
	onAcpSnapshot: (listener: (snapshot: AcpSessionSnapshot) => void) => subscribe("acp:snapshot", listener),

	qqBotStatus: (): Promise<QqBotStatus> => ipcRenderer.invoke("qqbot:status"),
	qqBotSave: (config: QqBotConfig): Promise<QqBotStatus> => ipcRenderer.invoke("qqbot:save", config),
	qqBotReconnect: (): Promise<QqBotStatus> => ipcRenderer.invoke("qqbot:reconnect"),
	qqBotPairing: (): Promise<QqBotStatus> => ipcRenderer.invoke("qqbot:pairing"),
	qqBotRevoke: (id: string): Promise<QqBotStatus> => ipcRenderer.invoke("qqbot:revoke", id),
	qqBotClearLog: (): Promise<QqBotStatus> => ipcRenderer.invoke("qqbot:clearLog"),
	qqBotChooseProject: (): Promise<string | null> => ipcRenderer.invoke("qqbot:chooseProject"),
	/** The connection redials on its own, and chats bind sessions while nobody looks. */
	onQqBotChanged: (listener: (status: QqBotStatus) => void) => subscribe("qqbot:changed", listener),
	agentAbort: (): Promise<void> => ipcRenderer.invoke("agent:abort"),
	agentCommands: (): Promise<SlashCommandSummary[]> =>
		ipcRenderer.invoke("agent:commands"),
	// Picker state for the welcome screen — a session snapshot before one exists.
	agentDefaults: (cwd: string): Promise<AgentDefaults> =>
		ipcRenderer.invoke("agent:defaults", cwd),
	onAgentDefaults: (listener: (defaults: AgentDefaults) => void) =>
		subscribe("agent:defaults", listener),
	// Null without a session: the pick is held as the welcome screen's default
	// and pushed back through onAgentDefaults.
	agentSetFusion: (config: FusionConfig): Promise<AgentSnapshot | null> =>
		ipcRenderer.invoke("agent:setFusion", config),
	agentSetFastContext: (config: FastContextConfig): Promise<AgentSnapshot | null> =>
		ipcRenderer.invoke("agent:setFastContext", config),
	agentSetModel: (modelKey: string): Promise<AgentSnapshot | null> =>
		ipcRenderer.invoke("agent:setModel", modelKey),
	agentSetThinking: (level: ThinkingLevel): Promise<AgentSnapshot | null> =>
		ipcRenderer.invoke("agent:setThinking", level),
	agentSetWorkMode: (mode: WorkMode): Promise<AgentSnapshot | null> => ipcRenderer.invoke("agent:setWorkMode", mode),
	agentAnswerWorkflow: (answer: WorkflowAnswer): Promise<AgentSnapshot> => ipcRenderer.invoke("agent:answerWorkflow", answer),
	agentCancelTask: (id: string): Promise<AgentSnapshot> => ipcRenderer.invoke("agent:cancelTask", id),
	agentSetMode: (mode: ExecutionMode): Promise<AgentSnapshot | null> =>
		ipcRenderer.invoke("agent:setMode", mode),
	// Null when the open session goes away (it was deleted).
	onAgentSnapshot: (listener: (snapshot: AgentSnapshot | null) => void) =>
		subscribe("agent:snapshot", listener),

	checkpointsList: (): Promise<CheckpointSummary[]> => ipcRenderer.invoke("checkpoints:list"),
	checkpointFileDiff: (id: string, path: string): Promise<CheckpointFileDiff> =>
		ipcRenderer.invoke("checkpoints:fileDiff", id, path),
	checkpointPreview: (id: string): Promise<CheckpointPreview> =>
		ipcRenderer.invoke("checkpoints:preview", id),
	checkpointRestore: (req: RestoreCheckpointRequest): Promise<RestoreCheckpointResult> =>
		ipcRenderer.invoke("checkpoints:restore", req),

	pluginsCatalog: (query: PluginCatalogQuery): Promise<PluginCatalogPage> =>
		ipcRenderer.invoke("plugins:catalog", query),
	pluginsList: (): Promise<PluginsSnapshot> => ipcRenderer.invoke("plugins:list"),
	pluginsInstall: (request: InstallPluginRequest): Promise<PluginsSnapshot> =>
		ipcRenderer.invoke("plugins:install", request),
	pluginsRemove: (request: PluginActionRequest): Promise<PluginsSnapshot> =>
		ipcRenderer.invoke("plugins:remove", request),
	pluginsUpdate: (source?: string): Promise<PluginsSnapshot> =>
		ipcRenderer.invoke("plugins:update", source),
	pluginsSetEnabled: (request: SetPluginEnabledRequest): Promise<PluginsSnapshot> =>
		ipcRenderer.invoke("plugins:setEnabled", request),
	onPluginsChanged: (listener: (snapshot: PluginsSnapshot) => void) =>
		subscribe("plugins:changed", listener),

	terminalCreate: (req: TerminalCreateRequest): Promise<TerminalSession> =>
		ipcRenderer.invoke("terminal:create", req),
	terminalInput: (req: TerminalInputRequest): Promise<void> =>
		ipcRenderer.invoke("terminal:input", req),
	terminalResize: (req: TerminalResizeRequest): Promise<void> =>
		ipcRenderer.invoke("terminal:resize", req),
	terminalKill: (id: string): Promise<void> =>
		ipcRenderer.invoke("terminal:kill", id),
	onTerminalData: (listener: (output: TerminalOutput) => void) =>
		subscribe("terminal:data", listener),
	onTerminalExit: (listener: (exit: TerminalExit) => void) =>
		subscribe("terminal:exit", listener),

	modelStatus: (): Promise<ModelStoreStatus> =>
		ipcRenderer.invoke("settings:modelStatus"),
	modelList: (): Promise<ModelProfileSummary[]> =>
		ipcRenderer.invoke("settings:listModels"),
	modelSave: (req: SaveModelProfileRequest): Promise<ModelProfileSummary> =>
		ipcRenderer.invoke("settings:saveModel", req),
	modelDelete: (id: string): Promise<void> =>
		ipcRenderer.invoke("settings:deleteModel", id),
	modelFetch: (req: FetchModelsRequest): Promise<FetchedModel[]> =>
		ipcRenderer.invoke("settings:fetchModels", req),
	modelTest: (req: ModelTestRequest): Promise<ModelTestResult> =>
		ipcRenderer.invoke("settings:testModel", req),

	skillsList: (): Promise<SkillsSnapshot> => ipcRenderer.invoke("skills:list"),
	skillsSetEnabled: (request: SetSkillEnabledRequest): Promise<SkillsSnapshot> =>
		ipcRenderer.invoke("skills:setEnabled", request),

	tokenUsage: (): Promise<TokenUsageReport> => ipcRenderer.invoke("stats:tokens"),
	tokenUsageRescan: (): Promise<TokenUsageReport> => ipcRenderer.invoke("stats:rescanTokens"),
	tokenUsageExport: (): Promise<string | null> => ipcRenderer.invoke("stats:exportTokens"),

	proxyStatus: (): Promise<ProxyStatus> => ipcRenderer.invoke("settings:proxyStatus"),
	proxySave: (manual: string | null): Promise<ProxyStatus> => ipcRenderer.invoke("settings:saveProxy", manual),

	oauthList: (): Promise<OAuthProviderSummary[]> => ipcRenderer.invoke("oauth:list"),
	oauthRefresh: (id: OAuthProviderId): Promise<OAuthProviderSummary> => ipcRenderer.invoke("oauth:refresh", id),
	oauthLogin: (id: OAuthProviderId): Promise<OAuthProviderSummary> =>
		ipcRenderer.invoke("oauth:login", id),
	oauthCancel: (id: OAuthProviderId): Promise<void> => ipcRenderer.invoke("oauth:cancel", id),
	oauthSubmitCode: (id: OAuthProviderId, code: string): Promise<void> =>
		ipcRenderer.invoke("oauth:submitCode", id, code),
	oauthLogout: (id: OAuthProviderId): Promise<OAuthProviderSummary> =>
		ipcRenderer.invoke("oauth:logout", id),
	onOAuthEvent: (listener: (event: OAuthLoginEvent) => void) => subscribe("oauth:event", listener),

	githubStatus: (): Promise<GitHubAuthStatus> => ipcRenderer.invoke("github:status"),
	githubSave: (token: string): Promise<GitHubAuthStatus> =>
		ipcRenderer.invoke("github:save", token),
	githubClear: (): Promise<GitHubAuthStatus> => ipcRenderer.invoke("github:clear"),

	prList: (cwd: string, filter: PullRequestFilter): Promise<PullRequestListResult> =>
		ipcRenderer.invoke("pr:list", cwd, filter),
	prDetail: (cwd: string, number: number): Promise<PullRequestDetail> =>
		ipcRenderer.invoke("pr:detail", cwd, number),
	prBranches: (cwd: string): Promise<RepositoryBranch[]> =>
		ipcRenderer.invoke("pr:branches", cwd),
	prCreate: (req: CreatePullRequestRequest): Promise<PullRequestSummary> =>
		ipcRenderer.invoke("pr:create", req),

	automationList: (): Promise<AutomationWithState[]> => ipcRenderer.invoke("automation:list"),
	automationGet: (id: string): Promise<AutomationWithState | null> =>
		ipcRenderer.invoke("automation:get", id),
	automationRuns: (id: string): Promise<AutomationRun[]> =>
		ipcRenderer.invoke("automation:runs", id),
	automationSave: (req: SaveAutomationRequest): Promise<AutomationWithState> =>
		ipcRenderer.invoke("automation:save", req),
	automationRemove: (id: string): Promise<void> => ipcRenderer.invoke("automation:remove", id),
	automationRunNow: (id: string): Promise<AutomationRun> =>
		ipcRenderer.invoke("automation:runNow", id),
	automationAbort: (id: string): Promise<void> => ipcRenderer.invoke("automation:abort", id),
	onAutomationEvent: (listener: (event: AutomationEvent) => void) =>
		subscribe("automation:event", listener),
};

export type NekoCodeDesktopApi = typeof api;

contextBridge.exposeInMainWorld("nekocode", api);

ipcRenderer.on("webui:rpc", (_event, request: WebUiBridgeRequest) => {
	const reply = (response: { ok: true; value: unknown } | { ok: false; error: string }) => {
		if (request && typeof request.id === "string") {
			ipcRenderer.send("webui:rpcResult", { id: request.id, ...response });
		}
	};
	if (
		!request ||
		typeof request.id !== "string" ||
		!isWebUiRpcMethod(request.method) ||
		!Array.isArray(request.args) ||
		request.args.length > 16
	) {
		reply({ ok: false, error: "Invalid WebUI bridge request" });
		return;
	}
	const fn = (api as Record<string, unknown>)[request.method];
	if (typeof fn !== "function") {
		reply({ ok: false, error: `Unknown WebUI method: ${request.method}` });
		return;
	}
	Promise.resolve()
		.then(() => (fn as (...args: unknown[]) => unknown)(...request.args))
		.then(
			(value) => reply({ ok: true, value }),
			(error: unknown) =>
				reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
		);
});

for (const channel of WEBUI_EVENT_CHANNELS) {
	ipcRenderer.on(channel, (_event, payload: unknown) => {
		ipcRenderer.send("webui:event", channel, payload);
	});
}

ipcRenderer.send("webui:ready");
