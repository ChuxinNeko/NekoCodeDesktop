import type { FusionConfig } from "../shared/fusion";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { DEFAULT_SHELL_INFO, type ShellInfo } from "../shared/window";
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
	ThinkingLevel,
} from "../shared/agent";
import type { FsEntry, FsReadResult } from "../shared/files";
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
	browserSetInspect: (guestId: number, enabled: boolean): Promise<void> => ipcRenderer.invoke("browser:setInspect", guestId, enabled),

	setTheme: (theme: "light" | "dark" | "system") =>
		ipcRenderer.invoke("theme:set", theme),

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
	agentSend: (req: SendPromptRequest): Promise<SendPromptResult> =>
		ipcRenderer.invoke("agent:send", req),
	agentAbort: (): Promise<void> => ipcRenderer.invoke("agent:abort"),
	// Picker state for the welcome screen — a session snapshot before one exists.
	agentDefaults: (cwd: string): Promise<AgentDefaults> =>
		ipcRenderer.invoke("agent:defaults", cwd),
	onAgentDefaults: (listener: (defaults: AgentDefaults) => void) =>
		subscribe("agent:defaults", listener),
	// Null without a session: the pick is held as the welcome screen's default
	// and pushed back through onAgentDefaults.
	agentSetFusion: (config: FusionConfig): Promise<AgentSnapshot | null> =>
		ipcRenderer.invoke("agent:setFusion", config),
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
