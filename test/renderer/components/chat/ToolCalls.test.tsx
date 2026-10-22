import { describe, expect, test } from "bun:test";
import type { AssistantCellData, ToolCellData, WorkItem } from "../../../../src/shared/transcript";
import { commandResult, workUnits } from "../../../../src/renderer/src/components/chat/ToolCalls";

const tool = (id: string, toolName: string, args: unknown = {}): WorkItem => ({
	kind: "tool",
	id,
	cell: { id, type: "tool", toolCallId: id, toolName, args, output: "", status: "done", timestamp: 0 } as ToolCellData,
});

const thought = (id: string, thinking = "hmm"): WorkItem => ({
	kind: "thinking",
	id,
	cell: { id, type: "assistant", text: "", thinking, streaming: false, timestamp: 0 } as unknown as AssistantCellData,
});

const shape = (items: WorkItem[], active = false) =>
	workUnits(items, active).map((unit) =>
		unit.kind === "computer"
			? `computer[${unit.steps.map((step) => (step.thought ? `${step.thought.id}>${step.cell.id}` : step.cell.id)).join(",")}]${unit.pending ? `+${unit.pending.id}` : ""}`
			: unit.item.id,
	);

describe("workUnits", () => {
	test("expanded timeline reasoning stays between desktop cards, including a live tail", () => {
		const items = [tool("a", "computer_click"), thought("t"), tool("b", "computer_scroll"), thought("tail")];
		for (const active of [true, false]) {
			const units = workUnits(items, active, { inlineThinking: true });
			expect(units.map((unit) => unit.kind === "computer" ? unit.steps.map((step) => step.cell.id).join(",") : unit.item.id)).toEqual(["a", items[1].id, "b", items[3].id]);
			expect(units.filter((unit) => unit.kind === "computer").every((unit) => !unit.pending && unit.steps.every((step) => !step.thought))).toBe(true);
		}
	});
	test("gathers adjacent desktop actions into one card", () => {
		expect(shape([tool("a", "read"), tool("b", "computer_click"), tool("c", "computer_type_text"), tool("d", "bash")])).toEqual([
			"a",
			"computer[b,c]",
			"d",
		]);
	});

	test("a single thought between two actions becomes the reason for the later one", () => {
		expect(shape([tool("a", "computer_click"), thought("t"), tool("b", "computer_scroll")])).toEqual(["computer[a,t>b]"]);
	});

	test("several thoughts break the run and stay in the group", () => {
		expect(shape([tool("a", "computer_click"), thought("t1"), thought("t2"), tool("b", "computer_click")])).toEqual([
			"computer[a]",
			"t1",
			"t2",
			"computer[b]",
		]);
	});

	test("a trailing thought is held by the card only while the run is live", () => {
		const items = [tool("a", "computer_click"), thought("t")];
		expect(shape(items, true)).toEqual(["computer[a]+t"]);
		expect(shape(items, false)).toEqual(["computer[a]", "t"]);
	});

	test("a thought before the first action stays outside the card", () => {
		expect(shape([thought("t"), tool("a", "computer_click")])).toEqual(["t", "computer[a]"]);
	});
});

describe("commandResult", () => {
	test("manual command stops show as stopped and retain the user's reason", () => {
		const output = "Command stopped by user.\nUser's reason: too slow\nDo not rerun without approval.";
		expect(commandResult(output, false, "error")).toEqual({ body: output, exitCode: null, stopped: "aborted" });
	});
	test("takes the local shell's exit status off the output", () => {
		expect(commandResult("boom\n\nCommand exited with code 2", false, "error")).toEqual({ body: "boom", exitCode: 2, stopped: null });
		expect(commandResult("ok\n", false, "done")).toEqual({ body: "ok", exitCode: 0, stopped: null });
		expect(commandResult("partial\n\nCommand timed out after 5 seconds", false, "error")).toMatchObject({ body: "partial", stopped: "timeout" });
	});

	test("reads the SSH tool's leading status line and stream markers", () => {
		expect(commandResult("[prod] exit code 0\n--- stdout ---\nhello\n", true, "done")).toEqual({
			body: "hello",
			exitCode: 0,
			stopped: null,
		});
		expect(commandResult("[prod] timed out after 60s and was killed\n(no output)", true, "done")).toMatchObject({
			body: "",
			stopped: "timeout",
		});
	});
});
