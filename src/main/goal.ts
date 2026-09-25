import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
	DEFAULT_GOAL_MAX_TURNS,
	GOAL_PROMPT_MARKER,
	MAX_GOAL_OBJECTIVE,
	type GoalState,
} from "../shared/goal";

export const GOAL_TOOL_NAME = "goal_update";

/** How the run that just ended finished, as far as the goal loop cares. */
export interface RunOutcome {
	/** The user pressed stop. */
	aborted: boolean;
	/** The last reply ended in an error the core's own retries did not cure. */
	error?: string;
	/** Workers are still out; their completion resumes the session on its own. */
	runningTasks: boolean;
	/** The session is waiting on the user's answer to a question card. */
	pendingQuestion: boolean;
}

/**
 * Every decision but "none" carries its reason, which is what the banner shows
 * as the loop's latest judgement.
 */
export type GoalDecision =
	| { type: "none" }
	/** Something else will start the next run; check again when it ends. */
	| { type: "wait"; reason: string }
	| { type: "continue"; reason: string }
	| { type: "pause"; reason: string };

/**
 * What to do with an active goal when a run ends. Pure, so the loop's rules
 * are tested without a model.
 */
export function decideAfterRun(goal: GoalState | null, outcome: RunOutcome): GoalDecision {
	if (!goal || goal.status !== "active") return { type: "none" };
	if (outcome.aborted) return { type: "pause", reason: "已由用户停止" };
	if (outcome.error) return { type: "pause", reason: `运行出错：${outcome.error}` };
	if (outcome.runningTasks) return { type: "wait", reason: "后台任务仍在运行，等其结果返回后再判断" };
	if (outcome.pendingQuestion) return { type: "wait", reason: "等待你回答 agent 的问题" };
	if (goal.turns >= goal.maxTurns) return { type: "pause", reason: `已达到自动续跑上限（${goal.maxTurns} 轮）` };
	return { type: "continue", reason: `本轮结束时尚未调用 ${GOAL_TOOL_NAME} 确认完成，继续推进` };
}

export function newGoal(objective: string, now = Date.now()): GoalState {
	const text = objective.trim();
	if (!text) throw new Error("用法：/goal <目标>");
	if (text.length > MAX_GOAL_OBJECTIVE) throw new Error(`目标描述不能超过 ${MAX_GOAL_OBJECTIVE} 字`);
	return {
		objective: text,
		status: "active",
		turns: 0,
		maxTurns: DEFAULT_GOAL_MAX_TURNS,
		startedAt: now,
		updatedAt: now,
		reason: "目标已设定，开始工作",
		activeMs: 0,
		activeSince: now,
		usage: { tokens: 0, cost: 0 },
	};
}

/** The user's turn that starts the loop. */
export function kickoffPrompt(goal: GoalState): string {
	return [
		GOAL_PROMPT_MARKER,
		"开始一个持续目标。你将自主工作，直到目标完全达成。",
		`目标：${goal.objective}`,
		"",
		"先弄清现状并制定计划（需要时用 todo_write 记录步骤），然后逐步执行。每轮结束后如果目标尚未完成，系统会自动让你继续。",
	].join("\n");
}

/** What main sends when a run ended short of the goal. */
export function continuationPrompt(goal: GoalState): string {
	return [
		`目标尚未完成，继续推进（自动续跑第 ${goal.turns}/${goal.maxTurns} 轮）。`,
		`目标：${goal.objective}`,
		"回顾已完成的工作和剩余差距，直接执行下一步，不要重复已经完成的工作，也不要只汇报进度就停下。",
		`确认目标已达成且经过验证后，调用 ${GOAL_TOOL_NAME}(status="complete")；确实无法继续时调用 ${GOAL_TOOL_NAME}(status="blocked")。`,
	].join("\n");
}

/** The system-prompt section while a goal is active. */
export function goalPromptSection(goal: GoalState | null): string {
	if (!goal || goal.status !== "active") return "";
	return [
		"## 当前持续目标（/goal，用户授权你自主持续工作直到完成）",
		`目标：${goal.objective}`,
		`进度：已自动续跑 ${goal.turns}/${goal.maxTurns} 轮。`,
		"- 自主推进：能自行判断的事直接决定并继续，不要为可逆的小决定停下来询问；只在缺少必要信息、授权或外部条件时才请求用户。",
		"- 每轮结束时若目标未完成，系统会自动发来续跑消息；不要仅汇报进度后等待。",
		`- 完成前必须验证：按项目实际情况运行测试、构建、类型检查或实际观察结果。验证通过后调用 ${GOAL_TOOL_NAME}(status="complete", summary=完成内容与验证证据)。`,
		`- 若因缺少信息、权限或外部条件而无法继续，调用 ${GOAL_TOOL_NAME}(status="blocked", summary=需要用户提供什么)。`,
		`- 只有 ${GOAL_TOOL_NAME} 能结束目标；不要在没有调用它的情况下宣称完成。目标不改变执行权限与工作模式的限制。`,
	].join("\n");
}

const goalSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
			description: "complete = the goal is achieved and verified; blocked = cannot continue without the user.",
		}),
		summary: Type.String({
			minLength: 1,
			maxLength: 4000,
			description: "complete: what was done and the verification evidence. blocked: exactly what is needed from the user.",
		}),
	},
	{ additionalProperties: false },
);

/**
 * The model's only way out of the goal loop. `finish` returns an error message
 * when there is no active goal, so a stray call cannot end something that is
 * not running.
 */
export function createGoalTool(finish: (status: "completed" | "blocked", note: string) => string | null): ToolDefinition {
	return {
		name: GOAL_TOOL_NAME,
		label: GOAL_TOOL_NAME,
		description:
			"End the active /goal. Call with status=complete only after the goal is fully achieved and verified (tests, build, or observed result), giving the evidence; call with status=blocked when you cannot continue without the user, saying exactly what you need. Until this is called, the system keeps sending continuation turns.",
		promptSnippet: `${GOAL_TOOL_NAME}(status=complete|blocked, summary) ends the active /goal; without it the loop continues.`,
		parameters: goalSchema,
		async execute(_id, params) {
			const input = params as Static<typeof goalSchema>;
			const problem = finish(input.status === "complete" ? "completed" : "blocked", input.summary.trim());
			if (problem) throw new Error(problem);
			const text =
				input.status === "complete"
					? "Goal marked complete. Give the user a short final summary; no further continuation turns will be sent."
					: "Goal marked blocked. Tell the user plainly what you need; the loop is paused until they resume it.";
			return { content: [{ type: "text", text }], details: { status: input.status } };
		},
	};
}
