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

export interface ThreadSummary {
	id: string;
	sessionFile: string;
	cwd: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
}

export interface AgentSnapshot {
	thread: ThreadSummary;
	cells: AgentCell[];
	streaming: boolean;
	modelKey: string | null;
	models: ModelOption[];
	thinkingLevel: ThinkingLevel;
	mode: ExecutionMode;
	error?: string;
}

export interface OpenThreadRequest {
	cwd: string;
	sessionFile: string;
}

export interface SendPromptRequest {
	text: string;
}

export type SendPromptResult =
	| { accepted: true; action?: "new-thread" | "open-terminal" }
	| { accepted: false; error: string };
