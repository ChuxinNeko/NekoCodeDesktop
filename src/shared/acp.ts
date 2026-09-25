import type { AgentCell, ContextUsage, PromptImageAttachment } from "./agent";

/**
 * External coding agents driven over the Agent Client Protocol.
 *
 * NekoCode is the ACP *client* here: it launches the agent's own CLI, speaks
 * JSON-RPC to it over stdio, and renders what it streams back. The agent owns
 * its model, credentials, tools and billing — NekoCode never sees a token.
 */

/** The workspace backed by NekoCode's own agent core and configured models. */
export const NEKO_LOCAL_WORKSPACE = "nekolocal";

/** How to launch one agent, as stored in settings. */
export interface AcpAgentConfig {
	id: string;
	name: string;
	command: string;
	args: string[];
	/** Extra environment for the agent process — API keys, CODEX_HOME, … */
	env: Record<string, string>;
	enabled: boolean;
}

/** One agent NekoCode knows how to launch. */
export interface AcpAgentInfo extends AcpAgentConfig {
	description: string;
	/** Shipped with NekoCode: can be edited and switched off, not removed. */
	builtin: boolean;
	/**
	 * The command line the user set, as shown so they know what will run.
	 * Empty for a built-in agent on its bundled adapter.
	 */
	commandLine: string;
	/** Runs the ACP adapter shipped inside NekoCode, which drives the user's own CLI. */
	bundled?: {
		/** e.g. "codex-acp 1.13.1". */
		adapter: string;
		/** The CLI it drives, e.g. "Codex CLI". */
		cliName: string;
		/** Where that CLI was found on this machine; null when it is not installed. */
		cliPath: string | null;
		/** How to get the CLI when it is missing. */
		installHint: string;
	};
}

export interface AcpSaveAgentRequest {
	/** Absent for a new custom agent. */
	id?: string;
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	enabled: boolean;
}

/** A conversation from the agent's own history, whether or not NekoCode started it. */
export interface AcpHistoryEntry {
	sessionId: string;
	cwd: string;
	title: string;
	updatedAt: number;
}

export interface AcpHistory {
	agentId: string;
	entries: AcpHistoryEntry[];
	/** The agent could not be asked, or does not keep a listable history. */
	error?: string;
}

export interface AcpOpenSessionRequest {
	agentId: string;
	sessionId: string;
	cwd: string;
	title?: string;
}

/** A select-style setting the agent exposes for a session (mode, model, …). */
export interface AcpConfigOption {
	id: string;
	name: string;
	description?: string;
	currentValue: string;
	options: Array<{ value: string; name: string; description?: string }>;
}

/** An action the agent wants the user to approve before it runs. */
export interface AcpPermissionRequest {
	id: string;
	toolCallId?: string;
	title: string;
	/** What exactly would run — the command, or the file being changed — when known. */
	detail?: string;
	options: Array<{ optionId: string; name: string; kind: AcpPermissionOptionKind }>;
}

export type AcpPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface AcpCommand {
	name: string;
	description: string;
	hint?: string;
}

export type AcpSessionStatus =
	/** The process is launching or the handshake is still running. */
	| "starting"
	| "ready"
	| "prompting"
	/** Startup failed or the process died; `error` says why. */
	| "error";

export interface AcpSessionSummary {
	id: string;
	/** The agent's own id for the conversation, once it has assigned one. */
	agentSessionId?: string;
	agentId: string;
	agentName: string;
	cwd: string;
	title: string;
	status: AcpSessionStatus;
	/**
	 * Started for a conversation that has not had a message yet. The composer
	 * opens one ahead of the first message so the agent's own pickers (model,
	 * reasoning, approvals) are there to set; it is not a conversation until then.
	 */
	pristine: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface AcpSessionSnapshot extends AcpSessionSummary {
	error?: string;
	cells: AgentCell[];
	streaming: boolean;
	context?: ContextUsage;
	configOptions: AcpConfigOption[];
	commands: AcpCommand[];
	permissions: AcpPermissionRequest[];
	supportsImages: boolean;
}

export interface AcpState {
	agents: AcpAgentInfo[];
	sessions: AcpSessionSummary[];
}

export interface AcpCreateSessionRequest {
	agentId: string;
	cwd: string;
	/**
	 * Opening a session ahead of the first message: an unsent one already open
	 * for this agent and directory is handed back instead of starting another.
	 */
	warm?: boolean;
}

export interface AcpPromptRequest {
	sessionId: string;
	text: string;
	images?: PromptImageAttachment[];
}

export interface AcpSetConfigRequest {
	sessionId: string;
	configId: string;
	value: string;
}

export interface AcpPermissionResponse {
	sessionId: string;
	requestId: string;
	/** Null cancels the request, which the agent treats as a refusal. */
	optionId: string | null;
}
