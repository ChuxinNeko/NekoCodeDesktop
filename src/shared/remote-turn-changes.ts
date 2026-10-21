import type { AgentSnapshot } from "./agent";
import type { CheckpointSummary } from "./checkpoints";
import { toolChangeStats } from "./tool-change-stats";

/** Project from the full transcript before its mobile history window is cut.
 * A long turn may no longer include its user prompt or its first edits remotely.
 */
export function remoteTurnChanges(snapshot: AgentSnapshot): CheckpointSummary | undefined {
	const cells = snapshot.cells;
	const index = cells.findLastIndex(cell => cell.type === "user");
	if (index < 0) return undefined;
	const checkpoint = snapshot.checkpoints?.find(entry => entry.cellId === cells[index].id);
	if (!checkpoint) return undefined;
	if (!snapshot.streaming) return checkpoint.files.length ? checkpoint : undefined;
	const root = (snapshot.session?.cwd ?? "").replace(/\\/g, "/").replace(/\/$/, "");
	const normalize = (value: string) => {
		const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
		return root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path;
	};
	const edits = new Map<string, { path: string; additions: number; deletions: number }>();
	for (const cell of cells.slice(index + 1)) {
		if (cell.type !== "tool" || cell.status === "error") continue;
		const stats = toolChangeStats(cell);
		const args = typeof cell.args === "object" && cell.args !== null ? cell.args as Record<string, unknown> : {};
		const rawPath = args.path ?? args.file_path;
		if (!stats || typeof rawPath !== "string" || !rawPath) continue;
		const path = normalize(rawPath), previous = edits.get(path);
		const count = (value: number) => cell.status !== "done" && value >= 5 ? Math.floor(value / 5) * 5 : value;
		edits.set(path, { path, additions: (previous?.additions ?? 0) + count(stats.insertions),
			deletions: (previous?.deletions ?? 0) + count(stats.deletions) });
	}
	const files = checkpoint.files.map(file => {
		const path = normalize(file.path), edit = edits.get(path);
		edits.delete(path);
		return edit ?? file;
	}).concat([...edits.values()]);
	return files.length ? { ...checkpoint, files, fileCount: files.length,
		additions: files.reduce((sum, file) => sum + file.additions, 0),
		deletions: files.reduce((sum, file) => sum + file.deletions, 0) } : undefined;
}
