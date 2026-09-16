import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AutomationEvent, AutomationRun, AutomationWithState, SaveAutomationRequest } from "../shared/automation";
import type { BrowserPopupRequest } from "../shared/browser";
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
	AgentSnapshot,
	ExecutionMode,
	OpenThreadRequest,
	SendPromptRequest,
	SendPromptResult,
	ThreadSummary,
	ThinkingLevel,
} from "../shared/agent";
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

const api = {
	initialProjectDir: (): Promise<string | null> =>
		ipcRenderer.invoke("app:initialProjectDir"),

	openExternal: (url: string): Promise<void> =>
		ipcRenderer.invoke("browser:openExternal", url),
	onBrowserPopup: (listener: (request: BrowserPopupRequest) => void) =>
		subscribe("browser:popup", listener),

	setTheme: (theme: "light" | "dark" | "system") =>
		ipcRenderer.invoke("theme:set", theme),

	gitStatus: (cwd: string) => ipcRenderer.invoke("git:status", cwd),
	gitDiff: (req: GitDiffRequest) => ipcRenderer.invoke("git:diff", req),
	gitFiles: (cwd: string, scope: ReviewScope) =>
		ipcRenderer.invoke("git:files", cwd, scope),
	gitAction: (req: GitActionRequest) => ipcRenderer.invoke("git:action", req),
	gitInit: (cwd: string) => ipcRenderer.invoke("git:init", cwd),
	pickDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),

	agentListThreads: (cwd: string): Promise<ThreadSummary[]> =>
		ipcRenderer.invoke("agent:listThreads", cwd),
	agentCreate: (cwd: string): Promise<AgentSnapshot> =>
		ipcRenderer.invoke("agent:create", cwd),
	agentOpen: (req: OpenThreadRequest): Promise<AgentSnapshot> =>
		ipcRenderer.invoke("agent:open", req),
	agentSnapshot: (): Promise<AgentSnapshot | null> =>
		ipcRenderer.invoke("agent:snapshot"),
	agentSend: (req: SendPromptRequest): Promise<SendPromptResult> =>
		ipcRenderer.invoke("agent:send", req),
	agentAbort: (): Promise<void> => ipcRenderer.invoke("agent:abort"),
	agentSetModel: (modelKey: string): Promise<AgentSnapshot> =>
		ipcRenderer.invoke("agent:setModel", modelKey),
	agentSetThinking: (level: ThinkingLevel): Promise<AgentSnapshot> =>
		ipcRenderer.invoke("agent:setThinking", level),
	agentSetMode: (mode: ExecutionMode): Promise<AgentSnapshot> =>
		ipcRenderer.invoke("agent:setMode", mode),
	onAgentSnapshot: (listener: (snapshot: AgentSnapshot) => void) =>
		subscribe("agent:snapshot", listener),

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
