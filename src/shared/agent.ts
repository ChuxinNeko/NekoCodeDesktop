import type { AgentPhase, WorkMode, WorkflowSnapshot } from "./workflow";
import type { CheckpointSummary } from "./checkpoints";
import type { FastContextConfig } from "./fast-context";
import type { FusionConfig } from "./fusion";

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
	thinkingLevels?: ThinkingLevel[];
	imageInput?: boolean;
	key: string;
	provider: string;
	/** The provider's own label — "zai", not the `nekocode-…` id it registers under. */
	providerName: string;
	id: string;
	name: string;
}

export function modelName(option: Pick<ModelOption, "id" | "name">): string {
	// A built-in model carries a written-out name ("Claude Sonnet 4.5"); a
	// configured one is registered under its id, and that is what gets trimmed.
	return option.name.trim() && option.name !== option.id
		? option.name
		: (option.id.split("/").pop() ?? option.id);
}

/**
 * What the pickers call a model: `provider/model`, e.g. `zai/glm-4.6`.
 *
 * A configured endpoint names its models by their raw API id, which is usually
 * a vendor-prefixed path — `zai-org/glm-4.6` — and pairing that with a provider
 * id like `nekocode-3f2a…` is a mouthful nobody reads. The provider half
 * already names the vendor, so the model half keeps only its last segment.
 */
export function modelLabel(
	option: Pick<ModelOption, "provider" | "providerName" | "id" | "name">,
): string {
	const provider = option.providerName.trim() || option.provider;
	return `${provider}/${modelName(option)}`;
}

/**
 * What one turn spent: every model call from the user's prompt until the agent
 * stopped working, summed.
 *
 * A turn, not a call, because a call is not a unit anyone acts on — a single
 * answer routinely takes a dozen of them around tool use, and most produce no
 * visible message to hang a number off.
 *
 * Token counts and cost come off the stored messages, so they survive reopening
 * a session; the two durations are wall-clock this window measured while the
 * turn ran and are absent for history it did not watch.
 */
export interface TurnUsage {
	/** Role-specific totals for Fusion, captured with this turn's configuration. */
	fusion?: {
		lead: TurnUsage;
		sidekick: { provider: string; model: string; usage?: TurnUsage };
	};
	fastContext?: {
		primary: TurnUsage;
		search: { provider: string; model: string; usage?: TurnUsage };
	};
	provider: string;
	model: string;
	/** What the provider actually served, when it is not the model requested. */
	responseModel?: string;
	/** Model calls the turn took. */
	calls: number;
	/** Prompt tokens billed at full rate — cache reads/writes are counted apart. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Thinking tokens, when the provider breaks them out. A subset of `output`. */
	reasoning?: number;
	totalTokens: number;
	costUsd?: number;
	/** First call's start to last call's end — tool execution included. */
	durationMs?: number;
	/** Time inside the model calls themselves, which is what a rate divides by. */
	modelMs?: number;
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
			/**
			 * Set on the last visible message of a finished turn, and nowhere else:
			 * it accounts for the whole turn, so it belongs at the end of it.
			 */
			usage?: TurnUsage;
	  }
	| {
			id: string;
			type: "tool";
			toolCallId: string;
			toolName: string;
			args: unknown;
			output: string;
			/**
			 * Set only on a remote transcript, where `output` was cut down to keep
			 * the transfer bounded: it holds the first characters of a result that
			 * is this many long, and the rest is fetched on demand. Absent locally,
			 * where the transcript always carries the whole thing.
			 */
			outputTotal?: number;
			details?: unknown;
			status: "pending" | "running" | "done" | "error";
			/** Tool arguments are still being generated; no file has been written yet. */
			inputStreaming?: boolean;
			/**
			 * When the call was issued. `timestamp` moves to the result once one
			 * lands — which is what orders the cell — so the start is kept apart
			 * rather than recovered from it.
			 */
			startedAt?: number;
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
	/** Live execution state, including sessions running outside the selected view. */
	running?: boolean;
	id: string;
	sessionFile: string;
	cwd: string;
	/** User-set name when there is one, else the opening prompt, else a placeholder. */
	title: string;
	/**
	 * A model-written title is in flight for this session. The row shows the
	 * localized "new session" placeholder until it lands, because `title` is
	 * still only the raw opening prompt at that point.
	 */
	titlePending: boolean;
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
	fastContext: FastContextConfig;
	fusion?: FusionConfig | null;
	modelKey: string | null;
	models: ModelOption[];
	thinkingLevel: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	mode: ExecutionMode;
	workMode: WorkMode;
	agentPhase: AgentPhase;
}

export interface ContextUsage {
	/**
	 * What the conversation occupied at the last model call: the whole prompt it
	 * sent — system prompt, every message, cached or not — plus the reply. Not
	 * the size of that reply on its own.
	 */
	used: number;
	/** The active model's context window. */
	window: number;
}

export interface AgentSnapshot {
	fastContext: FastContextConfig;
	fusion?: FusionConfig | null;
	session: SessionSummary;
	cells: AgentCell[];
	/**
	 * Set when `cells` is only the tail of the transcript: how many cells come
	 * before it. The window sent to the desktop starts at the end of a long
	 * session and reaches further back only as the user scrolls up to it.
	 */
	earlierCells?: number;
	/**
	 * Points this session can be put back to, newest first. Each one carries the
	 * `cellId` of the turn it sits in front of, which is what lets the transcript
	 * offer the rewind on the prompt it would undo.
	 */
	checkpoints: CheckpointSummary[];
	workflow: WorkflowSnapshot;
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
	workMode: WorkMode;
	/**
	 * The discipline Agent mode picked for the work in front of it. The picker
	 * shows it so an automatic switch is something the user watches happen rather
	 * than infers from the tools that went missing.
	 */
	agentPhase: AgentPhase;
	/**
	 * How full the context window is. Absent until a reply has reported usage,
	 * or when the active model declares no window.
	 */
	context?: ContextUsage;
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

export const MAX_PROMPT_IMAGES = 4;
export const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
export interface PromptImageAttachment {
	name: string;
	mimeType: string;
	data: string;
}

export interface SendPromptRequest {
	text: string;
	images?: PromptImageAttachment[];
}

/**
 * Start a task in a session of its own without leaving the one on screen.
 *
 * Creating and prompting are one call rather than two because a session that
 * was created but never prompted is nothing a user asked for — if the prompt is
 * refused there must be no leftover row in the sidebar to explain.
 */
export interface StartBackgroundTaskRequest {
	cwd: string;
	text: string;
}

export type StartBackgroundTaskResult =
	/**
	 * `warning` reports an arrangement the user did not pick — most often that
	 * isolation was asked for and the project could not have it, so this task is
	 * sharing the working directory after all.
	 */
	| { accepted: true; session: SessionSummary; warning?: string }
	| { accepted: false; error: string };

export type SendPromptResult =
	| { accepted: true; action?: "new-session" | "open-terminal" }
	| { accepted: false; error: string };
