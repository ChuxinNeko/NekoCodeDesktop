import { describe, expect, test } from "bun:test";
import type { AgentCell } from "../../../src/shared/agent";
import type { CheckpointSummary } from "../../../src/shared/checkpoints";
import { foldSettledTurns, groupTranscriptRows } from "../../../src/shared/transcript";
import { activeTurnChanges, completedTurnChanges } from "../../../src/renderer/src/lib/turnChanges";
import { fileEditStats } from "../../../src/renderer/src/lib/fileEditPreview";

const user = (id: string): AgentCell => ({ id, type: "user", text: id, timestamp: 1 });
const reply: AgentCell = { id: "answer", type: "assistant", text: "Done", thinking: "", streaming: false, timestamp: 3 };
const tool: AgentCell = { id: "edit", type: "tool", toolCallId: "edit", toolName: "write", args: { path: "a.ts" }, status: "done", output: "", timestamp: 2 };
export const checkpoint: CheckpointSummary = { id: "checkpoint", sessionId: "session", createdAt: 1, label: "Edit",
	cellId: "prompt", conversationRestorable: true, codeRestorable: true, fileCount: 1,
	files: [{ path: "a.ts", additions: 4, deletions: 2 }], additions: 4, deletions: 2, shellRuns: 0 };

describe("turn file changes", () => {
	test("appears with streaming input and follows the same complete-line counts as stage headings", () => {
		const empty = { ...checkpoint, files: [], fileCount: 0, additions: 0, deletions: 0 };
		for (const content of ["partial", "first\npart", "a\nb\nc\nd\ne\nf\ng\npart", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\npart"]) {
			const writing = { ...tool, status: "running" as const, inputStreaming: true, args: { path: "a.ts", content } };
			const live = activeTurnChanges([user("prompt"), writing], [empty], true)!;
			expect(live.files).toHaveLength(1);
			expect(live.additions).toBe(fileEditStats(writing, true).insertions);
			expect(live.additions).toBe(content === "partial" ? 0 : content.startsWith("first") ? 1 : content.includes("j") ? 10 : 5);
		}
	});
	test("aggregates repeated edits, normalizes paths, and reconciles checkpoint results without double counting", () => {
		const first = { ...tool, args: { path: "a.ts", content: "one\ntwo\n" } };
		const second = { ...tool, id: "second", toolName: "edit", status: "running" as const,
			args: { file_path: "D:\\work\\repo\\a.ts", oldText: "one", newText: "new\nline" } };
		const worker = { path: "worker.ts", additions: 6, deletions: 1 };
		const value = { ...checkpoint, files: [{ path: "a.ts", additions: 2, deletions: 0 }, worker] };
		const cells = [user("prompt"), first, second];
		const live = activeTurnChanges(cells, [value], true, "D:\\work\\repo")!;
		expect(live.files).toEqual([{ path: "a.ts", additions: 4, deletions: 1 }, worker]);
		expect(live).toMatchObject({ fileCount: 2, additions: 10, deletions: 2 });
		expect(activeTurnChanges(cells, [live], true, "D:\\work\\repo")).toEqual(live);
		const failed = { ...second, status: "error" as const };
		expect(activeTurnChanges([user("prompt"), first, failed], [value], true)?.files[0].additions).toBe(2);
		expect(activeTurnChanges([...cells, user("next")], [value], true)).toBeUndefined();
	});
	test("uses successful result diffs with exact counts once a tool finishes", () => {
		const result = { ...tool, toolName: "edit", args: { path: "a.ts", oldText: "stale", newText: "stale" },
			details: { diff: "+1 added\n+2 added\n-3 removed\n 4 context" } };
		expect(activeTurnChanges([user("prompt"), result], [checkpoint], true)).toMatchObject({ additions: 2, deletions: 1 });
	});
	test("rewound checkpoint markers never overwrite the replacement turn's live or final stats", () => {
		const cells = [user("prompt"), tool, reply];
		const oldMarker = { ...checkpoint, id: "abandoned", files: [], fileCount: 0, additions: 0, deletions: 0 };
		const checkpoints = [checkpoint, oldMarker];
		expect(activeTurnChanges(cells, checkpoints)).toBe(checkpoint);
		expect(completedTurnChanges(groupTranscriptRows(cells), checkpoints, true).size).toBe(0);
		expect([...completedTurnChanges(groupTranscriptRows(cells), checkpoints, false).values()]).toEqual([checkpoint]);
	});

	test("an empty replacement turn never borrows an older marker's file changes", () => {
		const cells = [user("prompt"), reply];
		const replacement = { ...checkpoint, id: "replacement", files: [], fileCount: 0, additions: 0, deletions: 0 };
		const checkpoints = [replacement, checkpoint];
		expect(activeTurnChanges(cells, checkpoints)).toBeUndefined();
		expect(completedTurnChanges(groupTranscriptRows(cells), checkpoints, false).size).toBe(0);
	});

	test("keeps the latest completed changes in the transcript once the turn ends", () => {
		const cells = [user("prompt"), tool, reply];
		const rows = foldSettledTurns(groupTranscriptRows(cells), false);
		expect(activeTurnChanges(cells, [checkpoint])).toBe(checkpoint);
		expect([...completedTurnChanges(rows, [checkpoint], false).values()]).toEqual([checkpoint]);
		const next = [...cells, user("next")];
		expect(activeTurnChanges(next, [checkpoint])).toBeUndefined();
		expect(completedTurnChanges(groupTranscriptRows(next), [checkpoint], true).size).toBe(1);
	});
	test("tracks only the latest prompt and never reuses previous turn changes", () => {
		expect(activeTurnChanges([user("prompt"), tool], [checkpoint])).toBe(checkpoint);
		expect(activeTurnChanges([user("prompt"), reply, user("next")], [checkpoint])).toBeUndefined();
		expect(activeTurnChanges([reply], [checkpoint])).toBeUndefined();
		expect(activeTurnChanges([user("prompt")], [{ ...checkpoint, files: [] }])).toBeUndefined();
	});
	test("moves the live summary into the completed transcript exactly once", () => {
		const cells = [user("prompt"), tool, reply];
		const rows = (streaming: boolean) => foldSettledTurns(groupTranscriptRows(cells), streaming);
		expect(completedTurnChanges(rows(true), [checkpoint], true).size).toBe(0);
		const completed = completedTurnChanges(rows(false), [checkpoint], false);
		expect([...completed.values()]).toEqual([checkpoint]);
		expect([...completed.keys()]).toEqual(["answer-message"]);
	});
	test("retains the summary when stopped without a final reply, or when no work row survives", () => {
		for (const cells of [[user("prompt"), tool], [user("prompt")]]) {
			const rows = groupTranscriptRows(cells);
			expect([...completedTurnChanges(rows, [checkpoint], false).values()]).toEqual([checkpoint]);
			expect(completedTurnChanges(rows, [checkpoint], true).size).toBe(0);
		}
	});
	test("keeps completed turns visible while the next turn is running", () => {
		const rows = foldSettledTurns(groupTranscriptRows([user("prompt"), tool, reply, user("next")]), true);
		expect([...completedTurnChanges(rows, [checkpoint], true).values()]).toEqual([checkpoint]);
	});
	test("shows worker files arriving in the parent checkpoint without a new lead message", () => {
		const cells = [user("prompt"), tool];
		const updated = { ...checkpoint, files: [...checkpoint.files, { path: "worker.ts", additions: 6, deletions: 1 }],
			fileCount: 2, additions: 10, deletions: 3 };
		expect(activeTurnChanges(cells, [checkpoint])?.files).toHaveLength(1);
		expect(activeTurnChanges(cells, [updated])?.files.map((file) => file.path)).toEqual(["a.ts", "worker.ts"]);
		expect(activeTurnChanges(cells, [updated])).toMatchObject({ additions: 10, deletions: 3 });
	});
});
