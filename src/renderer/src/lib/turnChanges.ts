import type { AgentCell } from "../../../shared/agent";
import type { CheckpointSummary } from "../../../shared/checkpoints";
import type { TranscriptRow } from "../../../shared/transcript";
import { fileEditStats } from "./fileEditPreview";

/** A diff request carries its checkpoint, so it always refers to the originating turn. */
export interface TurnDiffRequest {
	checkpoint: CheckpointSummary;
	path: string;
	nonce: number;
}

/** Match the current prompt, never carry the previous turn's files into a new run. */
export function activeTurnChanges(cells: readonly AgentCell[], checkpoints: readonly CheckpointSummary[], live = false, cwd = ""): CheckpointSummary | undefined {
	for (let i = cells.length - 1; i >= 0; i--) {
		const prompt = cells[i];
		if (prompt.type === "user") {
			const checkpoint = checkpoints.find((checkpoint) => checkpoint.cellId === prompt.id);
			if (checkpoint && live) {
				const normalize = (path: string) => {
					const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
					const root = cwd.replace(/\\/g, "/").replace(/\/$/, "");
					return root && clean.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? clean.slice(root.length + 1) : clean;
				};
				const edits = new Map<string, { path: string; additions: number; deletions: number }>();
				for (const cell of cells.slice(i + 1)) {
					if (cell.type !== "tool" || cell.status === "error" || !["edit", "write"].includes(cell.toolName)) continue;
					const stats = fileEditStats(cell, true);
					if (!stats.path) continue;
					const path = normalize(stats.path);
					const file = edits.get(path) ?? { path, additions: 0, deletions: 0 };
					file.additions += stats.insertions;
					file.deletions += stats.deletions;
					edits.set(path, file);
				}
				// Checkpoints retain worker/shell edits absent from the lead transcript.
				// Replace matching files instead of adding them a second time on completion.
				if (edits.size) {
					const files = checkpoint.files.map(file => {
						const key = normalize(file.path);
						const edit = edits.get(key);
						edits.delete(key);
						return edit ?? file;
					}).concat([...edits.values()]);
					return { ...checkpoint, files, fileCount: files.length,
						additions: files.reduce((total, file) => total + file.additions, 0),
						deletions: files.reduce((total, file) => total + file.deletions, 0) };
				}
			}
			return checkpoint?.files.length ? checkpoint : undefined;
		}
	}
	return undefined;
}

/**
 * Keep a completed turn's file summary on its final row, including stopped runs.
 * A turn that is still streaming stays out of this map; the composer shows a
 * live capsule for it instead, and the card joins the transcript once it ends.
 */
export function completedTurnChanges(rows: readonly TranscriptRow[], checkpoints: readonly CheckpointSummary[], streaming: boolean): Map<string, CheckpointSummary> {
	// Summaries arrive newest first. Older app/session data may still attach
	// several markers to one prompt after a rewind; never overwrite its newest.
	const byPrompt = new Map<string, CheckpointSummary>();
	for (const checkpoint of checkpoints) {
		if (checkpoint.cellId !== null && !byPrompt.has(checkpoint.cellId)) byPrompt.set(checkpoint.cellId, checkpoint);
	}
	const cards = new Map<string, CheckpointSummary>();
	let checkpoint: CheckpointSummary | undefined;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.kind === "user") checkpoint = byPrompt.get(row.cell.id);
		const next = rows[i + 1];
		const ended = next === undefined ? !streaming : next.kind === "user";
		if (ended && checkpoint && checkpoint.files.length > 0) cards.set(row.id, checkpoint);
	}
	return cards;
}
