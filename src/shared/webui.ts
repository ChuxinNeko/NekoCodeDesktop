import type { ShellInfo } from "./window";

export type WebUiHost = "localhost" | "0.0.0.0";

export interface WebUiStatus {
	enabled: boolean;
	running: boolean;
	host: WebUiHost;
	configuredPort: number | null;
	port: number | null;
	urls: string[];
	hasPassword: boolean;
	error: string | null;
	securePathEnabled: boolean;
}

export interface SaveWebUiConfigRequest {
	enabled: boolean;
	host: WebUiHost;
	port: number | null;
	password?: string;
	securePathEnabled: boolean;
}

export interface WebUiRuntime {
	runtime: "web";
	homeDir: string;
	shell: ShellInfo;
	basePath: string;
}

export interface WebUiBridgeRequest {
	id: string;
	method: WebUiRpcMethod;
	args: unknown[];
}

export type WebUiBridgeResponse =
	| { id: string; ok: true; value: unknown }
	| { id: string; ok: false; error: string };

export const WEBUI_RPC_METHODS = [
	"lanStatus",
	"lanSetEnabled",
	"lanPairing",
	"lanRevoke",
	"lanRemoveProject",
	"lanAddProjectPath",
	"relayStatus",
	"relayLogin",
	"relayRegister",
	"relayVerify",
	"relayResend",
	"relayLogout",
	"relayReconnect",
	"appVersion",
	"checkForUpdates",
	"checkForUpdatesOnStartup",
	"dismissStartupUpdate",
	"initialProjectDir",
	"directoryList",
	"gitStatus",
	"gitDiff",
	"gitFiles",
	"gitAction",
	"gitInit",
	"fsList",
	"fsReadFile",
	"sessionList",
	"sessionRename",
	"sessionDelete",
	"agentCreate",
	"agentOpen",
	"agentSnapshot",
	"agentLoadEarlier",
	"agentToolOutput",
	"agentSend",
	"agentStartBackground",
	"agentAbort",
	"agentCommands",
	"agentDefaults",
	"agentSetFusion",
	"agentSetFastContext",
	"agentSetModel",
	"agentSetThinking",
	"agentSetWorkMode",
	"agentAnswerWorkflow",
	"agentCancelTask",
	"agentSetMode",
	"preferencesGet",
	"preferencesUpdate",
	"worktreeStatus",
	"worktreeList",
	"worktreeMerge",
	"worktreeDiscard",
	"mcpList",
	"mcpSave",
	"mcpRemove",
	"mcpReconnect",
	"qqBotStatus",
	"qqBotSave",
	"qqBotReconnect",
	"qqBotPairing",
	"qqBotRevoke",
	"qqBotClearLog",
	"checkpointsList",
	"checkpointFileDiff",
	"checkpointPreview",
	"checkpointRestore",
	"pluginsCatalog",
	"pluginsList",
	"pluginsInstall",
	"pluginsRemove",
	"pluginsUpdate",
	"pluginsSetEnabled",
	"terminalCreate",
	"terminalInput",
	"terminalResize",
	"terminalKill",
	"modelStatus",
	"modelList",
	"modelSave",
	"modelDelete",
	"modelFetch",
	"modelTest",
	"skillsList",
	"skillsSetEnabled",
	"tokenUsage",
	"tokenUsageRescan",
	"tokenUsageExport",
	"proxyStatus",
	"proxySave",
	"oauthList",
	"oauthRefresh",
	"oauthLogin",
	"oauthCancel",
	"oauthSubmitCode",
	"oauthLogout",
	"githubStatus",
	"githubSave",
	"githubClear",
	"prList",
	"prDetail",
	"prBranches",
	"prCreate",
	"automationList",
	"automationGet",
	"automationRuns",
	"automationSave",
	"automationRemove",
	"automationRunNow",
	"automationAbort",
] as const;

export type WebUiRpcMethod = (typeof WEBUI_RPC_METHODS)[number];

export function isWebUiRpcMethod(value: unknown): value is WebUiRpcMethod {
	return typeof value === "string" && (WEBUI_RPC_METHODS as readonly string[]).includes(value);
}

export const WEBUI_EVENT_CHANNELS = [
	"relay:changed",
	"browser:popup",
	"browser:preview",
	"browser:elementSelected",
	"browser:inspectStopped",
	"agent:sessionsChanged",
	"agent:revealSession",
	"mcp:changed",
	"qqbot:changed",
	"agent:defaults",
	"agent:snapshot",
	"plugins:changed",
	"terminal:data",
	"terminal:exit",
	"oauth:event",
	"automation:event",
] as const;

export type WebUiEventChannel = (typeof WEBUI_EVENT_CHANNELS)[number];

export function isWebUiEventChannel(value: unknown): value is WebUiEventChannel {
	return typeof value === "string" && (WEBUI_EVENT_CHANNELS as readonly string[]).includes(value);
}
