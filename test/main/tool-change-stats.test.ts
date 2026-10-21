import { expect, test } from "bun:test";
import type { AgentCell, AgentSnapshot } from "../../src/shared/agent";
import { toolChangeStats } from "../../src/shared/tool-change-stats";
import { remoteView } from "../../src/main/agent-remote-view";
const tool = (name: string, args: unknown, more = {}) => ({ type: "tool", id: "edit-1", toolCallId: "call-1", toolName: name, args, output: "", status: "done", timestamp: 1, ...more }) as Extract<AgentCell, { type: "tool" }>;
test("change counts are computed from complete inputs before remote trimming", () => {
	const cell = tool("write", { path: "big.dart", content: "a".repeat(100) + "\n".repeat(10000) });
	const snapshot = { cells: [cell] } as AgentSnapshot;
	const projected = remoteView(snapshot).snapshot.cells[0];
	expect(projected.type).toBe("tool");
	if (projected.type !== "tool") throw new Error("missing tool");
	expect(projected.changeStats).toEqual({ insertions: 10000, deletions: 0 });
	expect((projected.args as { content: string }).content.length).toBeLessThan(5000);
});
test("streaming, batched edits and failed writes do not fabricate line counts", () => {
	expect(toolChangeStats(tool("write", { content: "a\r\nb\r\npartial" }, { inputStreaming: true }))).toEqual({ insertions: 2, deletions: 0 });
	expect(toolChangeStats(tool("edit", { edits: [{ oldText: "a\n", newText: "b\nc\n" }, null, { oldText: "d", newText: "e" }] }))).toEqual({ insertions: 3, deletions: 2 });
	expect(toolChangeStats(tool("edit", {}, { details: { diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n+extra" } }))).toEqual({ insertions: 2, deletions: 1 });
	expect(toolChangeStats(tool("write", { content: "a\nb" }, { status: "error" }))).toEqual({ insertions: 0, deletions: 0 });
	expect(toolChangeStats(tool("read", {}))).toBeUndefined();
});
test("the turn capsule survives history clipping without losing first edits or worker files", () => {
	const first = tool("write", { path: "/project/a.dart", content: "one\ntwo\n" });
	const last = tool("edit", { path: "a.dart", oldText: "one", newText: "three" });
	const snapshot = {
		session: { cwd: "/project" }, streaming: true,
		cells: [{ id: "u", type: "user", text: "change", timestamp: 0 }, first,
			...Array.from({ length: 70 }, (_, i) => ({ ...tool("read", { path: "readme" }), id: `read-${i}` })), last],
		checkpoints: [{ id: "cp", cellId: "u", files: [{ path: "worker.dart", additions: 7, deletions: 2 }] }],
	} as AgentSnapshot;
	const projected = remoteView(snapshot).snapshot;
	expect(projected.cells.some(cell => cell.id === "u")).toBe(false);
	expect(projected.currentTurnChanges?.files).toEqual([
		{ path: "worker.dart", additions: 7, deletions: 2 }, { path: "a.dart", additions: 3, deletions: 1 },
	]);
	const next = remoteView({ ...snapshot, cells: [...snapshot.cells, { id: "next", type: "user", text: "next", timestamp: 2 }] }).snapshot;
	expect(next.currentTurnChanges).toBeUndefined();
});
