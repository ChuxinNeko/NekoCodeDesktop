import type { FastContextConfig } from "../../shared/fast-context";
import type { FusionConfig } from "../../shared/fusion";
import type { LanStatus } from "../../shared/lan";
import type { AppVersionInfo, UpdateCheckResult } from "../../shared/updates";
import type {
	InstallPluginRequest,
	PluginActionRequest,
	PluginCatalogQuery,
	PluginCatalogPage,
	PluginsSnapshot,
	SetPluginEnabledRequest,
} from "../../shared/plugins";
import type { WorkMode, WorkflowAnswer } from "../../shared/workflow";
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
} from "../../shared/agent";
import type { BrowserPopupRequest, BrowserPreviewRequest, BrowserElementSelection } from "../../shared/browser";
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
import type {
	CheckpointFileDiff,
	CheckpointPreview,
	CheckpointSummary,
	RestoreCheckpointRequest,
	RestoreCheckpointResult,
} from "../../shared/checkpoints";
import type { FsEntry, FsReadResult, HostDirectoryListing } from "../../shared/files";
import type { MentionCandidate } from "../../shared/mentions";
import type { GoalAction } from "../../shared/goal";
import type { ProjectInstructions, SaveInstructionsRequest } from "../../shared/instructions";
import type { MemorySnapshot, SaveMemoryRequest } from "../../shared/memory";
import type { HooksSnapshot, SaveHookRequest } from "../../shared/hooks";
import type { GitActionRequest, GitDiffRequest, RepoStatus, ReviewScope } from "../../shared/git";
import type {
	FetchModelsRequest,
	FetchedModel,
	ModelProfileSummary,
	ModelStoreStatus,
	ModelTestRequest,
	ModelTestResult,
	OAuthLoginEvent,
	OAuthLoginOptions,
	OAuthProviderId,
	OAuthProviderSummary,
	OAuthUsageSnapshot,
	ProxyStatus,
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
import type { SlashCommandSummary } from "../../shared/commands";
import type {
	CreateSkillRequest,
	ImportSkillsRequest,
	ImportSkillsResult,
	RemoveSkillRequest,
	ScanSkillImportRequest,
	SetSkillEnabledRequest,
	SkillImportScan,
	SkillsSnapshot,
} from "../../shared/skills";
import type { AppPreferences, CommandShellOption } from "../../shared/preferences";
import type {
	WorktreeMergeRequest,
	WorktreeMergeResult,
	WorktreeRecord,
	WorktreeStatus,
} from "../../shared/worktree";
import type { McpSnapshot, SaveMcpServerRequest } from "../../shared/mcp";
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
} from "../../shared/acp";
import type { QqBotConfig, QqBotStatus } from "../../shared/qqbot";
import type {
	RelayLoginRequest,
	RelayRegisterRequest,
	RelayResendRequest,
	RelayStatus,
	RelayVerifyRequest,
} from "../../shared/relay";
import type { TokenUsageReport } from "../../shared/tokenStats";
import type { ShellInfo, WindowMaterial } from "../../shared/window";
import type { SaveWebUiConfigRequest, WebUiStatus } from "../../shared/webui";
import { createWebUiApi } from "./webui-api";

export interface AgentApi {
	readonly runtime: "electron" | "web";
	webUiStatus(): Promise<WebUiStatus>;
	webUiSave(request: SaveWebUiConfigRequest): Promise<WebUiStatus>;
	lanStatus(): Promise<LanStatus>;
	lanSetEnabled(enabled: boolean): Promise<LanStatus>;
	lanPairing(): Promise<LanStatus>;
	lanRevoke(id: string): Promise<LanStatus>;
	lanAddProject(): Promise<LanStatus>;
	lanRemoveProject(id: string): Promise<LanStatus>;
	relayStatus(): Promise<RelayStatus>;
	relayLogin(request: RelayLoginRequest): Promise<RelayStatus>;
	relayRegister(request: RelayRegisterRequest): Promise<void>;
	relayVerify(request: RelayVerifyRequest): Promise<RelayStatus>;
	relayResend(request: RelayResendRequest): Promise<void>;
	relayLogout(): Promise<RelayStatus>;
	relayReconnect(): Promise<RelayStatus>;
	onRelayChanged(listener: (status: RelayStatus) => void): () => void;
	appVersion(): Promise<AppVersionInfo>;
	checkForUpdates(): Promise<UpdateCheckResult>;
	checkForUpdatesOnStartup(): Promise<UpdateCheckResult | null>;
	dismissStartupUpdate(): Promise<void>;
	/** Window chrome the renderer lays out around: caption strip height, backdrop material. */
	shell: ShellInfo;
	/** The material this machine can composite; see {@link ShellInfo.materials}. */
	windowMaterial: WindowMaterial;
	/** The user's home directory — the working directory a fresh install starts in. */
	homeDir: string;

	initialProjectDir(): Promise<string | null>;

	openExternal(url: string): Promise<void>;
	onBrowserPopup(listener: (request: BrowserPopupRequest) => void): () => void;

	onBrowserPreview(listener: (request: BrowserPreviewRequest) => void): () => void;
	onBrowserElementSelected(listener: (selection: BrowserElementSelection) => void): () => void;
	onBrowserInspectStopped(listener: (state: { guestId: number }) => void): () => void;
	/** Main needs the automation page painted (a screenshot): bring its tab to the front. */
	onBrowserRevealAutomation(listener: (state: { guestId: number }) => void): () => void;
	browserSetInspect(guestId: number, enabled: boolean): Promise<void>;
	browserBindAutomation(requestId: string, guestId: number): Promise<void>;

	setTheme(theme: "light" | "dark" | "system"): Promise<void>;

	/** Applies a system window material; resolves with the shell it left behind. */
	setWindowMaterial(material: WindowMaterial): Promise<ShellInfo>;

	pickDirectory(): Promise<string | null>;
	directoryList(path: string): Promise<HostDirectoryListing>;
	lanAddProjectPath(path: string): Promise<LanStatus>;

	gitStatus(cwd: string): Promise<RepoStatus>;
	gitDiff(req: GitDiffRequest): Promise<string>;
	gitFiles(cwd: string, scope: ReviewScope): Promise<string[]>;
	gitAction(req: GitActionRequest): Promise<void>;
	gitInit(cwd: string): Promise<void>;

	fsList(cwd: string, relPath: string): Promise<FsEntry[]>;
	fsReadFile(cwd: string, relPath: string): Promise<FsReadResult>;

	sessionList(cwd?: string): Promise<SessionSummary[]>;
	sessionRename(req: RenameSessionRequest): Promise<void>;
	sessionDelete(req: DeleteSessionRequest): Promise<void>;
	onSessionsChanged(listener: () => void): () => void;

	agentCreate(cwd: string): Promise<AgentSnapshot>;
	agentOpen(req: OpenSessionRequest): Promise<AgentSnapshot>;
	agentSnapshot(): Promise<AgentSnapshot | null>;
	/**
	 * Reach one page further back into the open session. The window is only
	 * sent the tail of a long transcript; this extends it as the user scrolls up.
	 */
	agentLoadEarlier(): Promise<AgentSnapshot | null>;
	/** The rest of a tool result the window was only sent the head of. */
	agentToolOutput(toolCallId: string, offset: number): Promise<{ text: string; offset: number; total: number } | null>;
	agentSend(req: SendPromptRequest): Promise<SendPromptResult>;
	/** Run a prompt in a new session without changing what the window is showing. */
	agentStartBackground(req: StartBackgroundTaskRequest): Promise<StartBackgroundTaskResult>;
	/** A finished task's notification was clicked: bring that session up. */
	onRevealSession(listener: (session: SessionSummary) => void): () => void;
	preferencesGet(): Promise<AppPreferences>;
	preferencesUpdate(patch: Partial<AppPreferences>): Promise<AppPreferences>;
	/** The command shells this platform offers, and where each is installed. */
	preferencesCommandShells(): Promise<CommandShellOption[]>;
	/** Null when this session works in the project directory like any other. */
	worktreeStatus(sessionId: string): Promise<WorktreeStatus | null>;
	worktreeList(): Promise<WorktreeRecord[]>;
	worktreeMerge(req: WorktreeMergeRequest): Promise<WorktreeMergeResult>;
	worktreeDiscard(sessionId: string): Promise<void>;
	mcpList(): Promise<McpSnapshot>;
	mcpSave(req: SaveMcpServerRequest): Promise<McpSnapshot>;
	mcpRemove(id: string): Promise<McpSnapshot>;
	mcpReconnect(id: string): Promise<McpSnapshot>;
	/** Connection states move on their own — a server can drop at any time. */
	onMcpChanged(listener: (snapshot: McpSnapshot) => void): () => void;
	/** External ACP agents. Desktop only: the WebUI has no bridge for these. */
	acpState(): Promise<AcpState>;
	acpSnapshot(sessionId: string): Promise<AcpSessionSnapshot | null>;
	acpCreate(request: AcpCreateSessionRequest): Promise<AcpSessionSnapshot>;
	acpOpen(request: AcpOpenSessionRequest): Promise<AcpSessionSnapshot>;
	acpHistory(agentId: string): Promise<AcpHistory>;
	acpSaveAgent(request: AcpSaveAgentRequest): Promise<AcpAgentInfo[]>;
	acpRemoveAgent(id: string): Promise<AcpAgentInfo[]>;
	onAcpHistoryChanged(listener: (agentId: string) => void): () => void;
	acpPrompt(request: AcpPromptRequest): Promise<void>;
	acpCancel(sessionId: string): Promise<void>;
	acpSetConfig(request: AcpSetConfigRequest): Promise<void>;
	acpRespondPermission(response: AcpPermissionResponse): Promise<void>;
	acpClose(sessionId: string): Promise<void>;
	onAcpChanged(listener: (state: AcpState) => void): () => void;
	onAcpSnapshot(listener: (snapshot: AcpSessionSnapshot) => void): () => void;
	qqBotStatus(): Promise<QqBotStatus>;
	qqBotSave(config: QqBotConfig): Promise<QqBotStatus>;
	qqBotReconnect(): Promise<QqBotStatus>;
	/** Mint a code to send the bot from QQ. Single use, and it expires. */
	qqBotPairing(): Promise<QqBotStatus>;
	qqBotRevoke(id: string): Promise<QqBotStatus>;
	qqBotClearLog(): Promise<QqBotStatus>;
	/** Null when the folder picker was cancelled. */
	qqBotChooseProject(): Promise<string | null>;
	/** The connection redials on its own, and chats bind sessions while nobody looks. */
	onQqBotChanged(listener: (status: QqBotStatus) => void): () => void;
	agentAbort(): Promise<void>;
	/** Skills and prompt templates the composer's slash menu offers. */
	agentCommands(): Promise<SlashCommandSummary[]>;
	/** Pause, resume or clear the open session's `/goal`. */
	agentGoal(action: GoalAction): Promise<AgentSnapshot | null>;
	/** `@` candidates: files and folders, or symbols for a `#` query. `cwd` defaults to the open session's. */
	agentMentions(query: string, cwd?: string): Promise<MentionCandidate[]>;

	/** The AGENTS.md family a session in `cwd` loads, and where edits go. */
	instructionsRead(cwd: string): Promise<ProjectInstructions>;
	/** Writes the global or project file and reloads every open session. */
	instructionsSave(request: SaveInstructionsRequest): Promise<ProjectInstructions>;
	memoryList(): Promise<MemorySnapshot>;
	memorySave(request: SaveMemoryRequest): Promise<MemorySnapshot>;
	memoryRemove(id: string): Promise<MemorySnapshot>;
	onMemoryChanged(listener: (snapshot: MemorySnapshot) => void): () => void;
	hooksList(): Promise<HooksSnapshot>;
	hooksSave(request: SaveHookRequest): Promise<HooksSnapshot>;
	hooksRemove(id: string): Promise<HooksSnapshot>;
	hooksClearRecent(): Promise<HooksSnapshot>;
	onHooksChanged(listener: (snapshot: HooksSnapshot) => void): () => void;
	/** Picker state for the welcome screen — a session snapshot before one exists. */
	agentDefaults(cwd: string): Promise<AgentDefaults>;
	onAgentDefaults(listener: (defaults: AgentDefaults) => void): () => void;
	/** Null without a session: the pick becomes the welcome screen's default. */
	agentSetFusion(config: FusionConfig): Promise<AgentSnapshot | null>;
	agentSetFastContext(config: FastContextConfig): Promise<AgentSnapshot | null>;
	agentSetModel(modelKey: string): Promise<AgentSnapshot | null>;
	agentSetThinking(level: ThinkingLevel): Promise<AgentSnapshot | null>;
	agentSetMode(mode: ExecutionMode): Promise<AgentSnapshot | null>;
	agentSetWorkMode(mode: WorkMode): Promise<AgentSnapshot | null>;
	agentAnswerWorkflow(answer: WorkflowAnswer): Promise<AgentSnapshot>;
	agentCancelTask(id: string): Promise<AgentSnapshot>;
	onAgentSnapshot(listener: (snapshot: AgentSnapshot | null) => void): () => void;

	/** Checkpoints for the open session, newest first. Also carried on every snapshot. */
	checkpointsList(): Promise<CheckpointSummary[]>;
	/** One file's changes since a checkpoint, as a unified diff. */
	checkpointFileDiff(id: string, path: string): Promise<CheckpointFileDiff>;
	/** What restoring this checkpoint's code would change, for the confirmation. */
	checkpointPreview(id: string): Promise<CheckpointPreview>;
	checkpointRestore(req: RestoreCheckpointRequest): Promise<RestoreCheckpointResult>;

	pluginsCatalog(query: PluginCatalogQuery): Promise<PluginCatalogPage>;
	pluginsList(): Promise<PluginsSnapshot>;
	pluginsInstall(request: InstallPluginRequest): Promise<PluginsSnapshot>;
	pluginsRemove(request: PluginActionRequest): Promise<PluginsSnapshot>;
	pluginsUpdate(source?: string): Promise<PluginsSnapshot>;
	pluginsSetEnabled(request: SetPluginEnabledRequest): Promise<PluginsSnapshot>;
	onPluginsChanged(listener: (snapshot: PluginsSnapshot) => void): () => void;

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

	/** Built-in skills and what the open session loaded. Null without a session. */
	skillsList(): Promise<SkillsSnapshot | null>;
	/** Switches a built-in skill; rebuilds the open session's system prompt. */
	skillsSetEnabled(request: SetSkillEnabledRequest): Promise<SkillsSnapshot | null>;
	/** Writes a hand-entered skill into the user's or the project's skills directory. */
	skillsCreate(request: CreateSkillRequest): Promise<SkillsSnapshot | null>;
	/** The skills a folder holds, and which of them could be copied in. */
	skillsScanImport(request: ScanSkillImportRequest): Promise<SkillImportScan | null>;
	/** Copies chosen skill folders from that folder into a skills directory. */
	skillsImport(request: ImportSkillsRequest): Promise<ImportSkillsResult | null>;
	/** Moves an installed skill's folder to the recycle bin. */
	skillsRemove(request: RemoveSkillRequest): Promise<SkillsSnapshot | null>;

	/** Everything ever spent, rolled up from the transcripts on disk. */
	tokenUsage(): Promise<TokenUsageReport>;
	/** Same report, but parsed from scratch rather than resumed. */
	tokenUsageRescan(): Promise<TokenUsageReport>;
	/** Writes the ledger as CSV; resolves with the path, or null if cancelled. */
	tokenUsageExport(): Promise<string | null>;

	proxyStatus(): Promise<ProxyStatus>;
	proxySave(manual: string | null): Promise<ProxyStatus>;

	oauthList(): Promise<OAuthProviderSummary[]>;
	oauthRefresh(id: OAuthProviderId): Promise<OAuthProviderSummary>;
	oauthLogin(id: OAuthProviderId, options?: OAuthLoginOptions): Promise<OAuthProviderSummary>;
	/** How much of a signed-in subscription is left; `force` skips the short cache. */
	oauthUsage(id: OAuthProviderId, force?: boolean): Promise<OAuthUsageSnapshot>;
	oauthCancel(id: OAuthProviderId): Promise<void>;
	oauthSubmitCode(id: OAuthProviderId, code: string): Promise<void>;
	oauthLogout(id: OAuthProviderId): Promise<OAuthProviderSummary>;
	onOAuthEvent(listener: (event: OAuthLoginEvent) => void): () => void;

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

let resolvedApi: AgentApi | null = null;

/**
 * The bridge if this page has one, else null — never throws.
 *
 * Components shared with the phone app run in a WebView with neither bridge, so
 * anything they touch while rendering has to ask instead of reaching for
 * {@link api}: a Proxy is always truthy, which makes `api?.thing` on the phone a
 * thrown error rather than the `undefined` the `?.` was written for.
 */
export function optionalApi(): AgentApi | null {
	if (resolvedApi) return resolvedApi;
	if (window.nekocode) resolvedApi = window.nekocode as unknown as AgentApi;
	else if (window.__NEKOCODE_WEBUI__) resolvedApi = createWebUiApi(window.__NEKOCODE_WEBUI__);
	return resolvedApi;
}

function resolveApi(): AgentApi {
	const impl = optionalApi();
	if (!impl) {
		throw new Error(
			"NekoCode bridge unavailable: this page must run inside the desktop app or be served by its WebUI.",
		);
	}
	return impl;
}

/**
 * The preload bridge, typed. Renderer code should go through this module.
 *
 * Resolution is lazy: the mobile app shares renderer components that import
 * this module but never call it, and the Capacitor WebView has neither bridge —
 * resolving at import time would crash the whole bundle there. Code that *can*
 * run without a bridge must go through {@link optionalApi} instead.
 */
export const api: AgentApi = new Proxy({} as AgentApi, {
	get(_target, prop) {
		const impl = resolveApi() as unknown as Record<PropertyKey, unknown>;
		const value = impl[prop];
		return typeof value === "function" ? value.bind(impl) : value;
	},
});

/**
 * An error as the user should read it. A failure in the main process reaches
 * the window wrapped as "Error invoking remote method 'x': Error: …", which
 * names the plumbing rather than the problem.
 */
export function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, "");
}
