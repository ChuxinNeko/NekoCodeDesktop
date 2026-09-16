export type ExecutionMode = "read-only" | "auto" | "full-access";
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface ModelOption {
	key: string;
	provider: string;
	id: string;
	name: string;
}

export type AgentCell =
	| { id: string; type: "user"; text: string; timestamp: number }
	| {
			id: string;
			type: "assistant";
			text: string;
			thinking: string;
			streaming: boolean;
			error?: string;
			timestamp: number;
			/** ms epoch when the thinking block first appeared in the stream. */
			thinkingStartedAt?: number;
			/** ms epoch when non-thinking output began (or the message ended). */
			thinkingEndedAt?: number;
	  }
	| {
			id: string;
			type: "tool";
			toolCallId: string;
			toolName: string;
			args: unknown;
			output: string;
			status: "pending" | "running" | "done" | "error";
			timestamp: number;
	  }
	| {
			id: string;
			type: "notice";
			level: "info" | "warning" | "error";
			text: string;
			timestamp: number;
	  };

/** One row in the session list, and the header of the open session. */
export interface SessionSummary {
	id: string;
	sessionFile: string;
	cwd: string;
	/** User-set name when there is one, else the opening prompt, else a placeholder. */
	title: string;
	/**
	 * Second line of a row. Only set for renamed sessions, where the opening
	 * prompt is extra information; for the rest the title already is that prompt.
	 */
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
}

/**
 * The composer pickers' state before a session exists — what the next new
 * session starts with. Mirrors the pickers' half of AgentSnapshot.
 */
export interface AgentDefaults {
	modelKey: string | null;
	models: ModelOption[];
	thinkingLevel: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	mode: ExecutionMode;
}

export interface AgentSnapshot {
	session: SessionSummary;
	cells: AgentCell[];
	streaming: boolean;
	modelKey: string | null;
	models: ModelOption[];
	thinkingLevel: ThinkingLevel;
	/**
	 * Levels the active model actually accepts. A non-reasoning model only offers
	 * "off", and PI silently clamps anything else back to it — so the picker has
	 * to offer these rather than the full list.
	 */
	thinkingLevels: ThinkingLevel[];
	mode: ExecutionMode;
	error?: string;
}

export interface OpenSessionRequest {
	cwd: string;
	sessionFile: string;
}

export interface RenameSessionRequest {
	sessionFile: string;
	cwd: string;
	title: string;
}

export interface DeleteSessionRequest {
	sessionFile: string;
}

export interface SendPromptRequest {
	text: string;
}

export type SendPromptResult =
	| { accepted: true; action?: "new-session" | "open-terminal" }
	| { accepted: false; error: string };
