import { describe, expect, test } from "bun:test";
import type { FusionEvent } from "../../src/main/fusion/reference/core/types";
import { createInitialState, fusionReducer } from "../../src/shared/fusion-engine-state";
import { isTeamThreadTurn, mergeTeamThreads, settledTeamThreadTurn, teamThreadItems, teamThreadTurn, teamThreadTurns } from "../../src/shared/team-thread";

const id = "s1";
const coordinated: FusionEvent[] = [
	{ type: "session.started", sessionId: id, models: { main: "p/lead", sidekick: "team" } },
	{ type: "plan.completed", sessionId: id, plan: { complexity: 0.5, mainTask: "@Chief coordinates", sidekickTasks: [] } },
	{ type: "task.started", sessionId: id, role: "main", task: "@Chief", model: "p/lead" },
	{ type: "session.output.delta", sessionId: id, delta: "Let me get Coder on it." },
	{ type: "tool.started", sessionId: id, role: "main", task: "@Chief", toolCallId: "a1", toolName: "team_assign", input: { assignments: [{ member: "@Coder", task: "Fix the bug in a.ts" }] } },
	{ type: "task.started", sessionId: id, role: "sidekick", task: "@Coder: Fix the bug in a.ts", model: "p/code", workerId: "w1" },
	{ type: "tool.started", sessionId: id, role: "sidekick", task: "@Coder: Fix the bug in a.ts", toolCallId: "t1", toolName: "read", input: { path: "a.ts" }, workerId: "w1" },
	{ type: "tool.completed", sessionId: id, role: "sidekick", task: "@Coder: Fix the bug in a.ts", toolCallId: "t1", toolName: "read", output: {}, durationMs: 3, workerId: "w1" },
	{ type: "task.output.delta", sessionId: id, role: "sidekick", task: "@Coder: Fix the bug in a.ts", delta: "Fixed", workerId: "w1" },
	{ type: "task.completed", sessionId: id, role: "sidekick", task: "@Coder: Fix the bug in a.ts", text: "Fixed it: a.ts line 3.", workerId: "w1" },
	{ type: "tool.completed", sessionId: id, role: "main", task: "@Chief", toolCallId: "a1", toolName: "team_assign", output: {}, durationMs: 9 },
	{ type: "session.output.delta", sessionId: id, delta: "Coder fixed the bug." },
	{ type: "task.completed", sessionId: id, role: "main", task: "@Chief", text: "Coder fixed the bug." },
	{ type: "session.completed", sessionId: id, text: "Coder fixed the bug.", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
] as FusionEvent[];

describe("team thread", () => {
	test("draws the admin, its hand-off and the member's report as chat messages, without repeating the final answer", () => {
		const items = teamThreadItems(coordinated, "Coder fixed the bug.");
		expect(items.map(item => [item.kind, item.member])).toEqual([["message", "Chief"], ["assign", "Chief"], ["message", "Coder"]]);
		expect(items[0]).toMatchObject({ text: "Let me get Coder on it.", status: "done" });
		expect(items[1]).toMatchObject({ to: "Coder", task: "Fix the bug in a.ts" });
		expect(items[2]).toMatchObject({ text: "Fixed it: a.ts line 3.", status: "done", tools: [{ name: "read", detail: "a.ts", status: "done" }] });
	});
	test("a running member shows as typing; turns come from the engine state and only for team runs", () => {
		const running = teamThreadItems(coordinated.slice(0, 6));
		expect(running.at(-1)).toMatchObject({ member: "Coder", text: "", status: "running" });
		let state = fusionReducer(createInitialState(), { type: "run.submitted", prompt: "fix it" });
		for (const event of coordinated) state = fusionReducer(state, { type: "event.received", event });
		expect(teamThreadTurns(state)).toHaveLength(1);
		expect(teamThreadTurns(state)[0]).toMatchObject({ prompt: "fix it", status: "complete" });
		let fusion = fusionReducer(createInitialState(), { type: "run.submitted", prompt: "x" });
		fusion = fusionReducer(fusion, { type: "event.received", event: { type: "session.started", sessionId: id, models: { main: "a", sidekick: "b" } } });
		expect(teamThreadTurns(fusion)).toHaveLength(0);
	});
	test("the final answer is sent by the admin, or by the one member answering directly; several direct replies keep their bubbles", () => {
		expect(teamThreadTurn(coordinated, "fix it", "complete", "Coder fixed the bug.").final).toEqual({ member: "Chief", text: "Coder fixed the bug." });
		const direct = [coordinated[0], { type: "plan.completed", sessionId: id, plan: { complexity: 0.5, mainTask: "Direct: @Coder", sidekickTasks: [] } }, ...coordinated.slice(5, 10)] as FusionEvent[];
		const one = teamThreadTurn(direct, "@Coder fix", "complete", "Fixed it: a.ts line 3.");
		expect(one.final).toEqual({ member: "Coder", text: "Fixed it: a.ts line 3." });
		expect(one.items).toMatchObject([{ member: "Coder", text: "", tools: [{ name: "read" }] }]);
		const reviewer = direct.slice(2).map(event => JSON.parse(JSON.stringify(event).replaceAll("w1", "w2").replaceAll("@Coder", "@Reviewer").replaceAll("Fixed it", "Looks fine"))) as FusionEvent[];
		const both = teamThreadTurn([...direct, ...reviewer], "@all", "complete", "**@Coder**\n\nFixed it: a.ts line 3.\n\n---\n\n**@Reviewer**\n\nLooks fine: a.ts line 3.");
		expect(both.final?.member).toBeNull();
		expect(both.items.map(item => item.kind === "message" ? item.text : "")).toEqual(["Fixed it: a.ts line 3.", "Looks fine: a.ts line 3."]);
	});
	test("a run saved while unfinished stops typing; saved turns merge with the running one", () => {
		const settled = settledTeamThreadTurn(teamThreadTurn(coordinated.slice(0, 7), "fix it", "running"));
		expect(settled.status).toBe("failed");
		expect(settled.items.at(-1)).toMatchObject({ status: "failed", tools: [{ status: "failed" }] });
		let state = fusionReducer(createInitialState(), { type: "run.submitted", prompt: "next" });
		for (const event of coordinated.slice(0, 4)) state = fusionReducer(state, { type: "event.received", event });
		expect(mergeTeamThreads([settled], state, 42).map(turn => [turn.prompt, turn.status, turn.userTimestamp])).toEqual([["fix it", "failed", undefined], ["next", "running", 42]]);
		state = fusionReducer(state, { type: "event.received", event: coordinated.at(-1)! });
		expect(mergeTeamThreads([settled], state)).toHaveLength(1);
		expect(isTeamThreadTurn(settled)).toBe(true);
		expect(isTeamThreadTurn({ prompt: 1 })).toBe(false);
	});
});
