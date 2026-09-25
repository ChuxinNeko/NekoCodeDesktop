/**
 * `/goal`: an objective the agent keeps working on, turn after turn, until it
 * says it is done — or cannot go on without the user.
 *
 * The loop lives in main: when a run ends and the goal is still active, main
 * sends the next "keep going" turn itself. The model ends the loop only by
 * calling the goal tool, so a reply that merely *sounds* finished does not.
 */

export type GoalStatus = "active" | "paused" | "completed" | "blocked";

export interface GoalState {
	objective: string;
	status: GoalStatus;
	/** Automatic continuations sent so far. The user's own turns do not count. */
	turns: number;
	maxTurns: number;
	startedAt: number;
	updatedAt: number;
	/**
	 * The loop's most recent decision and why: carrying on because the goal is
	 * not confirmed done, waiting on workers, paused on an error, or — from the
	 * model — the evidence it is done or what it needs to go on.
	 */
	reason?: string;
	/** Time spent active before the current stretch; paused time is not counted. */
	activeMs: number;
	/** When the current active stretch began; absent unless active. */
	activeSince?: number;
	/** What the session's own replies have cost since the goal was set. */
	usage: GoalUsage;
}

export interface GoalUsage {
	tokens: number;
	/** In USD, as the provider's price table reports it; 0 where it has none. */
	cost: number;
}

/** How long the goal has been active, stopping the clock while it is not. */
export function goalElapsedMs(goal: GoalState, now = Date.now()): number {
	return goal.activeMs + (goal.status === "active" && goal.activeSince !== undefined ? Math.max(0, now - goal.activeSince) : 0);
}

/**
 * The goal in a new status, with the active clock started or stopped to match.
 * Every status change goes through here so the elapsed time cannot drift.
 */
export function withGoalStatus(goal: GoalState, status: GoalStatus, reason: string | undefined, now = Date.now()): GoalState {
	const wasActive = goal.status === "active" && goal.activeSince !== undefined;
	const activeMs = wasActive ? goal.activeMs + Math.max(0, now - goal.activeSince!) : goal.activeMs;
	const next: GoalState = { ...goal, status, reason, activeMs, updatedAt: now };
	if (status === "active") next.activeSince = now;
	else delete next.activeSince;
	return next;
}

/** "1h 02m", "3m 05s", "12s" — a clock, not a stopwatch. */
export function formatGoalElapsed(ms: number): string {
	const total = Math.floor(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

export type GoalAction = { type: "pause" } | { type: "resume" } | { type: "clear" };

/** Continuations before the loop pauses and hands back to the user. */
export const DEFAULT_GOAL_MAX_TURNS = 30;
export const MAX_GOAL_OBJECTIVE = 4000;

/** Session entry the state is saved in, so a reopened session shows its goal. */
export const GOAL_ENTRY = "nekocode.goal.v1";
/** Custom message type of an automatic continuation turn. */
export const GOAL_MESSAGE = "nekocode.goal";

/** First line of the prompt `/goal` expands into; the transcript shows the command instead. */
export const GOAL_PROMPT_MARKER = "<!-- nekocode:goal -->";

/** `/goal …` for an expanded kickoff prompt, or null for any other text. */
export function displayGoalPrompt(text: string, objective?: string): string | null {
	if (!text.startsWith(GOAL_PROMPT_MARKER)) return null;
	const match = /\n目标：([\s\S]*?)\n\n/.exec(text);
	const shown = objective ?? match?.[1]?.trim() ?? "";
	return shown ? `/goal ${shown}` : "/goal";
}

/**
 * A saved goal as this version reads it. Entries written before the clock and
 * the usage existed load with both at zero rather than failing to load.
 */
export function readGoalState(value: unknown): GoalState | null {
	if (!isGoalState(value)) return null;
	const raw = value as GoalState & { note?: string };
	const usage = raw.usage && typeof raw.usage.tokens === "number" && typeof raw.usage.cost === "number" ? raw.usage : { tokens: 0, cost: 0 };
	return {
		...raw,
		reason: raw.reason ?? raw.note,
		activeMs: typeof raw.activeMs === "number" ? raw.activeMs : 0,
		usage,
	};
}

export function isGoalState(value: unknown): value is GoalState {
	if (!value || typeof value !== "object") return false;
	const goal = value as Partial<GoalState>;
	return (
		typeof goal.objective === "string" &&
		(goal.status === "active" || goal.status === "paused" || goal.status === "completed" || goal.status === "blocked") &&
		typeof goal.turns === "number" &&
		typeof goal.maxTurns === "number" &&
		typeof goal.startedAt === "number" &&
		typeof goal.updatedAt === "number"
	);
}
