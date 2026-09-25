import { describe, expect, test } from "bun:test";
import {
	displayGoalPrompt,
	formatGoalElapsed,
	GOAL_MESSAGE,
	goalElapsedMs,
	isGoalState,
	readGoalState,
	withGoalStatus,
	type GoalState,
} from "../shared/goal";
import { projectMessages } from "./agent-projection";
import {
	continuationPrompt,
	createGoalTool,
	decideAfterRun,
	GOAL_TOOL_NAME,
	goalPromptSection,
	kickoffPrompt,
	newGoal,
	type RunOutcome,
} from "./goal";
import { buildModePrompt, toolsForMode } from "./prompt-library";

const idle: RunOutcome = { aborted: false, runningTasks: false, pendingQuestion: false };
const active = (overrides: Partial<GoalState> = {}): GoalState => ({ ...newGoal("让所有测试通过", 1), ...overrides });

describe("decideAfterRun", () => {
	test("an active goal keeps going after a normal run", () => {
		expect(decideAfterRun(active(), idle)).toMatchObject({ type: "continue", reason: expect.stringContaining(GOAL_TOOL_NAME) });
	});

	test("nothing happens without an active goal", () => {
		expect(decideAfterRun(null, idle)).toEqual({ type: "none" });
		for (const status of ["paused", "completed", "blocked"] as const)
			expect(decideAfterRun(active({ status }), idle)).toEqual({ type: "none" });
	});

	test("stop, errors and the turn limit pause it", () => {
		expect(decideAfterRun(active(), { ...idle, aborted: true })).toMatchObject({ type: "pause" });
		expect(decideAfterRun(active(), { ...idle, error: "429" })).toMatchObject({ type: "pause", reason: expect.stringContaining("429") });
		expect(decideAfterRun(active({ turns: 30, maxTurns: 30 }), idle)).toMatchObject({ type: "pause" });
	});

	test("workers and open questions make it wait rather than push", () => {
		expect(decideAfterRun(active(), { ...idle, runningTasks: true })).toMatchObject({ type: "wait", reason: expect.stringContaining("后台任务") });
		expect(decideAfterRun(active(), { ...idle, pendingQuestion: true })).toMatchObject({ type: "wait" });
	});

	test("a user stop outranks everything else", () => {
		expect(decideAfterRun(active(), { ...idle, aborted: true, runningTasks: true })).toMatchObject({ type: "pause" });
	});
});

describe("goal state", () => {
	test("newGoal trims and validates", () => {
		const goal = newGoal("  修复登录  ", 5);
		expect(goal).toMatchObject({ objective: "修复登录", status: "active", turns: 0, startedAt: 5 });
		expect(isGoalState(goal)).toBe(true);
		expect(() => newGoal("   ")).toThrow();
		expect(() => newGoal("x".repeat(5000))).toThrow();
		expect(isGoalState({ objective: "x" })).toBe(false);
	});

	test("prompts carry the objective and the way out", () => {
		const goal = active({ turns: 3 });
		expect(kickoffPrompt(goal)).toContain("让所有测试通过");
		expect(continuationPrompt(goal)).toContain("3/30");
		expect(continuationPrompt(goal)).toContain(GOAL_TOOL_NAME);
		expect(goalPromptSection(goal)).toContain(GOAL_TOOL_NAME);
		expect(goalPromptSection(active({ status: "paused" }))).toBe("");
		expect(goalPromptSection(null)).toBe("");
	});
});

describe("clock and spend", () => {
	test("only active time counts, across pauses", () => {
		let goal = newGoal("x", 0);
		expect(goalElapsedMs(goal, 5_000)).toBe(5_000);
		goal = withGoalStatus(goal, "paused", "暂停", 5_000);
		expect(goal.activeSince).toBeUndefined();
		expect(goalElapsedMs(goal, 60_000)).toBe(5_000);
		goal = withGoalStatus(goal, "active", "继续", 60_000);
		expect(goalElapsedMs(goal, 62_000)).toBe(7_000);
		goal = withGoalStatus(goal, "completed", "done", 70_000);
		expect(goalElapsedMs(goal, 999_999)).toBe(15_000);
		expect(goal.reason).toBe("done");
	});

	test("entries saved before the clock existed still load", () => {
		const old = { objective: "x", status: "paused", turns: 2, maxTurns: 30, startedAt: 1, updatedAt: 2, note: "旧原因" };
		expect(readGoalState(old)).toMatchObject({ activeMs: 0, usage: { tokens: 0, cost: 0 }, reason: "旧原因" });
		expect(readGoalState({ objective: 1 })).toBeNull();
	});

	test("elapsed reads as a clock", () => {
		expect(formatGoalElapsed(12_400)).toBe("12s");
		expect(formatGoalElapsed(185_000)).toBe("3m 05s");
		expect(formatGoalElapsed(3_720_000)).toBe("1h 02m");
	});
});

describe("goal tool", () => {
	test("reports completion through the callback, and fails with no goal", async () => {
		let result = null as [string, string] | null;
		let running = true;
		const tool = createGoalTool((status, note) => {
			if (!running) return "No active goal";
			result = [status, note];
			running = false;
			return null;
		});
		const run = (params: unknown) => tool.execute("id", params as never, undefined, undefined, undefined as never);
		await run({ status: "complete", summary: " tests pass: 42/42 " });
		expect(result).toEqual(["completed", "tests pass: 42/42"]);
		await expect(run({ status: "blocked", summary: "need key" })).rejects.toThrow("No active goal");
	});

	test("is offered only while a goal is active, read-only included, never to workers", () => {
		const base = { mode: "agent", permission: "auto", interactive: true } as const;
		expect(toolsForMode(base)).not.toContain(GOAL_TOOL_NAME);
		expect(toolsForMode({ ...base, goal: "## goal" })).toContain(GOAL_TOOL_NAME);
		expect(toolsForMode({ ...base, permission: "read-only", goal: "## goal" })).toContain(GOAL_TOOL_NAME);
		expect(toolsForMode({ ...base, child: true, goal: "## goal" })).not.toContain(GOAL_TOOL_NAME);
		expect(buildModePrompt({ ...base, goal: "## 当前持续目标 X" })).toContain("## 当前持续目标 X");
	});
});

describe("transcript", () => {
	test("the kickoff shows as the command, a continuation as its label", () => {
		const kickoff = kickoffPrompt(active());
		expect(displayGoalPrompt(kickoff)).toBe("/goal 让所有测试通过");
		const cells = projectMessages([
			{ role: "user", content: kickoff, timestamp: 1 },
			{
				role: "custom",
				customType: GOAL_MESSAGE,
				content: continuationPrompt(active({ turns: 1 })),
				display: true,
				details: { label: "目标未完成，自动继续（第 1/30 轮）" },
				timestamp: 2,
			},
		]);
		expect(cells.map((cell) => ("text" in cell ? cell.text : ""))).toEqual([
			"/goal 让所有测试通过",
			"目标未完成，自动继续（第 1/30 轮）",
		]);
	});
});
