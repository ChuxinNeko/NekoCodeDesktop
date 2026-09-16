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
} from "../../shared/agent";
import type { BrowserPopupRequest } from "../../shared/browser";
import type {
	AutomationEvent,
	AutomationRun,
	AutomationWithState,
	SaveAutomationRequest,
} from "../../shared/automation";
import type {
	CreatePullRequestRequest,
	GitHubAuthStatus,
	PullRequestDetail,
	PullRequestFilter,
	PullRequestListResult,
	PullRequestSummary,
	RepositoryBranch,
} from "../../shared/pullRequests";
import type { GitActionRequest, GitDiffRequest, RepoStatus, ReviewScope } from "../../shared/git";
import type {
	FetchModelsRequest,
	FetchedModel,
	ModelProfileSummary,
	ModelStoreStatus,
	ModelTestRequest,
	ModelTestResult,
	SaveModelProfileRequest,
} from "../../shared/settings";
import type {
	TerminalCreateRequest,
	TerminalExit,
	TerminalInputRequest,
	TerminalOutput,
	TerminalResizeRequest,
	TerminalSession,
} from "../../shared/terminal";
import type { ShellInfo } from "../../shared/window";

export interface AgentApi {
	/** Window chrome the renderer lays out around: caption strip height, backdrop material. */
	shell: ShellInfo;
	/** The user's home directory — the working directory a fresh install starts in. */
	homeDir: string;

	initialProjectDir(): Promise<string | null>;

	openExternal(url: string): Promise<void>;
	onBrowserPopup(listener: (request: BrowserPopupRequest) => void): () => void;

	setTheme(theme: "light" | "dark" | "system"): Promise<void>;

	pickDirectory(): Promise<string | null>;

	gitStatus(cwd: string): Promise<RepoStatus>;
	gitDiff(req: GitDiffRequest): Promise<string>;
	gitFiles(cwd: string, scope: ReviewScope): Promise<string[]>;
	gitAction(req: GitActionRequest): Promise<void>;
	gitInit(cwd: string): Promise<void>;

	sessionList(cwd: string): Promise<SessionSummary[]>;
	sessionRename(req: RenameSessionRequest): Promise<void>;
	sessionDelete(req: DeleteSessionRequest): Promise<void>;
	onSessionsChanged(listener: () => void): () => void;

	agentCreate(cwd: string): Promise<AgentSnapshot>;
	agentOpen(req: OpenSessionRequest): Promise<AgentSnapshot>;
	agentSnapshot(): Promise<AgentSnapshot | null>;
	agentSend(req: SendPromptRequest): Promise<SendPromptResult>;
	agentAbort(): Promise<void>;
	/** Picker state for the welcome screen — a session snapshot before one exists. */
	agentDefaults(cwd: string): Promise<AgentDefaults>;
	onAgentDefaults(listener: (defaults: AgentDefaults) => void): () => void;
	/** Null without a session: the pick becomes the welcome screen's default. */
	agentSetModel(modelKey: string): Promise<AgentSnapshot | null>;
	agentSetThinking(level: ThinkingLevel): Promise<AgentSnapshot | null>;
	agentSetMode(mode: ExecutionMode): Promise<AgentSnapshot | null>;
	onAgentSnapshot(listener: (snapshot: AgentSnapshot | null) => void): () => void;

	terminalCreate(req: TerminalCreateRequest): Promise<TerminalSession>;
	terminalInput(req: TerminalInputRequest): Promise<void>;
	terminalResize(req: TerminalResizeRequest): Promise<void>;
	terminalKill(id: string): Promise<void>;
	onTerminalData(listener: (output: TerminalOutput) => void): () => void;
	onTerminalExit(listener: (exit: TerminalExit) => void): () => void;

	modelStatus(): Promise<ModelStoreStatus>;
	modelList(): Promise<ModelProfileSummary[]>;
	modelSave(req: SaveModelProfileRequest): Promise<ModelProfileSummary>;
	modelDelete(id: string): Promise<void>;
	modelFetch(req: FetchModelsRequest): Promise<FetchedModel[]>;
	modelTest(req: ModelTestRequest): Promise<ModelTestResult>;

	githubStatus(): Promise<GitHubAuthStatus>;
	githubSave(token: string): Promise<GitHubAuthStatus>;
	githubClear(): Promise<GitHubAuthStatus>;

	prList(cwd: string, filter: PullRequestFilter): Promise<PullRequestListResult>;
	prDetail(cwd: string, number: number): Promise<PullRequestDetail>;
	prBranches(cwd: string): Promise<RepositoryBranch[]>;
	prCreate(req: CreatePullRequestRequest): Promise<PullRequestSummary>;

	automationList(): Promise<AutomationWithState[]>;
	automationGet(id: string): Promise<AutomationWithState | null>;
	automationRuns(id: string): Promise<AutomationRun[]>;
	automationSave(req: SaveAutomationRequest): Promise<AutomationWithState>;
	automationRemove(id: string): Promise<void>;
	automationRunNow(id: string): Promise<AutomationRun>;
	automationAbort(id: string): Promise<void>;
	onAutomationEvent(listener: (event: AutomationEvent) => void): () => void;
}

/** The preload bridge, typed. Renderer code should go through this module. */
export const api: AgentApi = window.nekocode as unknown as AgentApi;

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
