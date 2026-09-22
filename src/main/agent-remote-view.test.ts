import { describe, expect, test } from "bun:test";
import type { AgentCell, AgentSnapshot } from "../shared/agent";
import {
	REMOTE_FIELD_LIMIT,
	REMOTE_NEW_BUDGET,
	REMOTE_OUTPUT_CHUNK,
	REMOTE_WINDOW,
	remoteToolOutput,
	remoteView,
} from "./agent-remote-view";

function snapshot(cells: AgentCell[]): AgentSnapshot {
	return { session: { id: "s1" }, cells, models: [], checkpoints: [] } as unknown as AgentSnapshot;
}

function userCells(count: number): AgentCell[] {
	return Array.from({ length: count }, (_, i) => (
		{ id: `c${String(i + 1)}`, type: "user", text: `m${String(i + 1)}`, timestamp: i }
	));
}

function toolCell(overrides: Partial<Extract<AgentCell, { type: "tool" }>> = {}): AgentCell {
	return {
		id: "t1", type: "tool", toolCallId: "tc1", toolName: "read",
		args: {}, output: "", status: "done", timestamp: 1,
		...overrides,
	} as AgentCell;
}

const OVERSIZED = "x".repeat(REMOTE_FIELD_LIMIT + 5000);

describe("remoteView windowing", () => {
	test("sends the tail of a long transcript and says there is more", () => {
		const view = remoteView(snapshot(userCells(150)));
		expect(view.snapshot.cells).toHaveLength(REMOTE_WINDOW);
		expect(view.snapshot.cells[0].id).toBe("c91");
		expect(view.more).toBe(true);
	});

	test("a short transcript arrives whole with nothing behind it", () => {
		const view = remoteView(snapshot(userCells(5)));
		expect(view.snapshot.cells).toHaveLength(5);
		expect(view.more).toBe(false);
	});

	test("anchors on the cell the client already holds rather than sliding forward", () => {
		const view = remoteView(snapshot(userCells(150)), { from: "c40" });
		expect(view.snapshot.cells[0].id).toBe("c40");
		expect(view.snapshot.cells).toHaveLength(111);
		expect(view.more).toBe(true);
	});

	test("`back` extends the window and is clamped to one step", () => {
		const extended = remoteView(snapshot(userCells(300)), { from: "c200", back: 60 });
		expect(extended.snapshot.cells[0].id).toBe("c140");

		const clamped = remoteView(snapshot(userCells(300)), { from: "c200", back: 10_000 });
		expect(clamped.snapshot.cells[0].id).toBe("c140");
	});

	test("an anchor a rewind removed falls back to the tail", () => {
		const view = remoteView(snapshot(userCells(150)), { from: "c-gone" });
		expect(view.snapshot.cells[0].id).toBe("c91");
		expect(view.more).toBe(true);
	});
});

describe("remoteView trimming", () => {
	test("caps a large tool output to a clean prefix plus its true length", () => {
		const [cell] = remoteView(snapshot([toolCell({ output: OVERSIZED })])).snapshot.cells;
		const tool = cell as Extract<AgentCell, { type: "tool" }>;
		// A prefix and a length, not an inline notice: a fetched chunk has to join
		// straight onto the end of what is already there.
		expect(tool.output).toBe(OVERSIZED.slice(0, REMOTE_FIELD_LIMIT));
		expect(tool.outputTotal).toBe(OVERSIZED.length);
	});

	test("leaves output that already fits untouched and unmarked", () => {
		const [cell] = remoteView(snapshot([toolCell({ output: "small" })])).snapshot.cells;
		const tool = cell as Extract<AgentCell, { type: "tool" }>;
		expect(tool.output).toBe("small");
		expect(tool.outputTotal).toBeUndefined();
	});

	test("reaches into arguments and result details, however they are nested", () => {
		const [cell] = remoteView(snapshot([toolCell({
			toolName: "edit",
			args: { file_path: "/a.ts", edits: [{ oldText: OVERSIZED, newText: "ok" }] },
			details: { diff: OVERSIZED },
		})])).snapshot.cells;
		const tool = cell as Extract<AgentCell, { type: "tool" }>;
		const edits = (tool.args as { edits: Array<{ oldText: string; newText: string }> }).edits;
		expect(edits[0].oldText.length).toBeLessThan(OVERSIZED.length);
		expect(edits[0].newText).toBe("ok");
		// Short values keep their exact shape — paths are what the row is labelled by.
		expect((tool.args as { file_path: string }).file_path).toBe("/a.ts");
		expect((tool.details as { diff: string }).diff.length).toBeLessThan(OVERSIZED.length);
	});

	test("never truncates a task result, which the transcript parses as JSON", () => {
		const output = JSON.stringify({ id: "worker-1", padding: OVERSIZED });
		const [cell] = remoteView(snapshot([toolCell({ toolName: "task", output })])).snapshot.cells;
		expect(JSON.parse((cell as Extract<AgentCell, { type: "tool" }>).output)).toMatchObject({ id: "worker-1" });
	});

	test("never truncates the assistant's own answer", () => {
		const cells: AgentCell[] = [
			{ id: "a1", type: "assistant", text: OVERSIZED, thinking: "", streaming: false, timestamp: 1 },
		];
		const [cell] = remoteView(snapshot(cells)).snapshot.cells;
		expect((cell as Extract<AgentCell, { type: "assistant" }>).text).toHaveLength(OVERSIZED.length);
	});
});

describe("remoteView byte budget", () => {
	/** A cell whose many oversized fields all survive the per-field trim. */
	function fatCell(id: string, edits = 12): AgentCell {
		return toolCell({
			id, toolCallId: id, toolName: "edit",
			args: { edits: Array.from({ length: edits }, () => ({ oldText: OVERSIZED, newText: OVERSIZED })) },
			details: { diff: OVERSIZED },
			output: OVERSIZED,
		});
	}

	test("clips the window so one response cannot overrun the relay frame", () => {
		const view = remoteView(snapshot(Array.from({ length: 60 }, (_, i) => fatCell(`t${String(i)}`))));
		// The bound that matters: still inside the relay's 1 MB plaintext limit
		// once base64 has added its third.
		expect(JSON.stringify(view.snapshot.cells).length * 1.37).toBeLessThan(1024 * 1024);
		expect(view.snapshot.cells.length).toBeLessThan(60);
		expect(view.more).toBe(true);
	});

	test("always carries one cell, however large that single turn is", () => {
		// One turn on its own past the budget: sending nothing would put it out of
		// reach for good, so it goes alone.
		const view = remoteView(snapshot([...userCells(3), fatCell("huge", 100)]));
		expect(view.snapshot.cells.map((cell) => cell.id)).toEqual(["huge"]);
		expect(view.more).toBe(true);
	});

	test("a plain poll keeps the whole held window, budget or not", () => {
		const view = remoteView(snapshot(Array.from({ length: 20 }, (_, i) => fatCell(`t${String(i)}`))), { from: "t0" });
		expect(view.snapshot.cells).toHaveLength(20);
		expect(view.more).toBe(false);
	});
});

describe("remoteToolOutput", () => {
	const long = "y".repeat(REMOTE_OUTPUT_CHUNK + 1000);

	test("serves the result in chunks the client can stitch back together", () => {
		const current = snapshot([toolCell({ toolCallId: "tc1", output: long })]);
		const first = remoteToolOutput(current, "tc1", 0)!;
		expect(first.offset).toBe(0);
		expect(first.total).toBe(long.length);
		expect(first.text).toHaveLength(REMOTE_OUTPUT_CHUNK);

		const rest = remoteToolOutput(current, "tc1", first.text.length)!;
		expect(first.text + rest.text).toBe(long);
	});

	test("clamps an offset past the end instead of reading off it", () => {
		const current = snapshot([toolCell({ toolCallId: "tc1", output: "short" })]);
		expect(remoteToolOutput(current, "tc1", 9999)).toEqual({ text: "", offset: 5, total: 5 });
		expect(remoteToolOutput(current, "tc1", -5)).toMatchObject({ offset: 0, text: "short" });
	});

	test("is null for a tool call the window no longer holds", () => {
		expect(remoteToolOutput(snapshot(userCells(2)), "tc1", 0)).toBeNull();
	});
});
