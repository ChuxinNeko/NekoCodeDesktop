import type { ExecutionMode } from "./agent";

export const WORK_MODES = ["agent", "ask", "plan", "debug", "multitask"] as const;
export type WorkMode = (typeof WORK_MODES)[number];
export type PromptRole = WorkMode | "subagent" | "commit";
export function isWorkMode(value: unknown): value is WorkMode {
	return typeof value === "string" && (WORK_MODES as readonly string[]).includes(value);
}

/**
 * The discipline Agent mode is working under right now.
 *
 * Agent is the automatic mode: the user picks it once and the model matches the
 * phase to the task instead of asking them to pick a mode per request. The other
 * work modes stay as manual pins for anyone who wants the behaviour nailed down.
 *
 * A phase is not a permission. It narrows which tools are live and which
 * discipline the prompt carries; what the session is allowed to do at all is
 * still the independent execution permission, which only the user can raise.
 */
export const AGENT_PHASES = ["answer", "plan", "execute", "debug", "delegate"] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

/** Where a session starts, and what Agent falls back to: today's Agent behaviour. */
export const DEFAULT_AGENT_PHASE: AgentPhase = "execute";

export function isAgentPhase(value: unknown): value is AgentPhase {
	return typeof value === "string" && (AGENT_PHASES as readonly string[]).includes(value);
}

/**
 * The phase a `switch_mode` request lands on inside the automatic mode.
 *
 * The model keeps one vocabulary — the work-mode names — whether it is asking
 * the user to change modes or picking its own phase; the runtime decides which
 * of the two a request means from the mode the session is actually in.
 */
export const PHASE_FOR_MODE: Record<WorkMode, AgentPhase> = {
	agent: "execute",
	ask: "answer",
	plan: "plan",
	debug: "debug",
	multitask: "delegate",
};

export function isReadOnly(
	mode: PromptRole,
	permission: ExecutionMode,
	phase?: AgentPhase,
): boolean {
	return (
		permission === "read-only" ||
		mode === "ask" ||
		mode === "plan" ||
		mode === "subagent" ||
		mode === "commit" ||
		// The investigating phases are read-only for the same reason Ask and Plan
		// are: a mode that may edit while it is still deciding what to do is not
		// investigating, whatever its prompt says.
		(mode === "agent" && (phase === "answer" || phase === "plan"))
	);
}
export interface WorkflowQuestion {
	id: string;
	question: string;
	options: Array<{ id: string; label: string; description?: string }>;
}
export interface WorkflowRequest {
	id: string;
	kind: "question" | "mode-switch";
	title: string;
	questions: WorkflowQuestion[];
}
export interface WorkflowAnswer {
	requestId: string;
	answers: Record<string, { optionId?: string; text?: string }>;
	cancelled?: boolean;
}
export interface WorkflowTodo {
	id: string;
	text: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
}
export const TASK_OUTCOMES = ["completed", "blocked", "needs_decision", "needs_escalation"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];
export interface FusionTaskReport {
	outcome: TaskOutcome;
	summary: string;
	acceptance: Array<{ criterion: string; status: "met" | "unverified" | "not_met"; evidence: string }>;
	/** Evidence and a concrete question, never authorization to switch models. */
	decision?: string;
}
export interface TaskRunResult {
	text: string;
	outcome?: TaskOutcome;
}

export interface TaskExecutionPlan {
	/** Ordered implementation steps decided by Lead. */
	steps: string[];
	/** User restrictions and decisions that the isolated worker must preserve. */
	constraints: string[];
	acceptanceCriteria: string[];
	verification: {
		mode: "run" | "skip";
		/** Specific commands/scenarios; empty when verification is forbidden. */
		checks: string[];
	};
}

export interface TaskInput {
	/** Required for Fusion workers, optional for ordinary tasks. */
	executionPlan?: TaskExecutionPlan;
	/** Lead-authored visual decisions, passed verbatim to the isolated worker. */
	designSpec?: string;
	description: string;
	prompt: string;
	kind: "explore" | "worker";
	writablePaths: string[];
}

/** Workers that may run at once. The panel shows every slot, filled or not. */
export const MAX_WORKERS = 4;

/** Newest steps kept per worker; a long worker is a tail, not a transcript. */
export const MAX_TASK_STEPS = 40;

/** How much of a worker's tool output or narration crosses the bridge. */
export const MAX_STEP_DETAIL = 4000;

/**
 * One thing a background worker did, as the parent's UI sees it.
 *
 * Live only, and deliberately not persisted: a step is what a worker is doing
 * *now*, and a reopened session has no worker left to watch. What outlives the
 * run is the result the worker reported.
 *
 * Tool steps carry their output so the detail panel can show what the worker
 * actually saw; message steps are what it said between calls, which is the
 * thread that makes a list of tool calls read as work rather than noise;
 * thinking steps are why it did any of it.
 */
export type TaskStep =
	| {
			kind: "thinking";
			id: string;
			/** Grows while the worker reasons; replaced in place, never appended to. */
			text: string;
			startedAt: number;
			/** Set once the worker starts producing output instead of reasoning. */
			endedAt?: number;
	  }
	| {
			kind: "tool";
			/** The child's tool call id — stable across its start and end events. */
			id: string;
			toolName: string;
			/** One-line argument preview, truncated before it crosses the bridge. */
			args: string;
			/** The tool's output. Absent until it returns. */
			output?: string;
			status: "running" | "done" | "error";
			startedAt: number;
			endedAt?: number;
	  }
	| {
			kind: "message";
			id: string;
			text: string;
			startedAt: number;
	  };

export interface WorkflowTask {
	id: string;
	description: string;
	kind: TaskInput["kind"];
	writablePaths: string[];
	status: "running" | "completed" | "failed" | "cancelled";
	startedAt: number;
	endedAt?: number;
	result?: string;
	/** Run completion is separate from meeting acceptance or needing Lead's decision. */
	outcome?: TaskOutcome;
	steps: TaskStep[];
}

/**
 * One run of the Fast Context explorer behind `code_search`.
 *
 * Live only, like a worker's steps: it exists so the agent map can show the
 * explorer working while the parent waits on it, and a reopened session has
 * nothing left to show. The report it returns is in the transcript.
 */
export interface ExplorerRun {
	id: string;
	/** What the parent asked it to find. */
	query: string;
	/** `provider/model` of the model doing the exploring. */
	model?: string;
	/** The `code_search` call that started it, so its transcript row can show it working. */
	toolCallId?: string;
	status: "running" | "completed" | "failed" | "cancelled";
	startedAt: number;
	endedAt?: number;
	steps: TaskStep[];
}

/** Finished explorer runs kept for the map after they end. */
export const MAX_FINISHED_EXPLORERS = 5;

/** A task as it is written to the session file — see {@link TaskStep}. */
export type SavedWorkflowTask = Omit<WorkflowTask, "steps">;
export interface WorkflowSnapshot {
	maxWorkers?: number;
	request: WorkflowRequest | null;
	todos: WorkflowTodo[];
	tasks: WorkflowTask[];
	/** Explorer runs of this session, running first; absent where nothing has explored. */
	explorers?: ExplorerRun[];
}
export interface WorkflowSavedState {
	version: 1;
	workMode: WorkMode;
	/** Absent in sessions written before the automatic mode existed. */
	phase?: AgentPhase;
	todos: WorkflowTodo[];
	tasks: SavedWorkflowTask[];
}
