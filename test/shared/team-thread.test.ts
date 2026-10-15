import { describe, expect, test } from "bun:test";
import type { FusionEvent } from "../../src/main/fusion/reference/core/types";
import { createInitialState, fusionReducer } from "../../src/shared/fusion-engine-state";
import { teamThreadItems, teamThreadTurns } from "../../src/shared/team-thread";

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
	test("direct replies that are the answer are marked instead of repeated", () => {
		const direct = [coordinated[0], { type: "plan.completed", sessionId: id, plan: { complexity: 0.5, mainTask: "Direct: @Coder", sidekickTasks: [] } }, ...coordinated.slice(5, 10)] as FusionEvent[];
		expect(teamThreadItems(direct, "Fixed it: a.ts line 3.")).toMatchObject([{ member: "Coder", answered: true }]);
	});
});
