import type { AgentCell } from "../../../shared/agent";
import type { CheckpointSummary } from "../../../shared/checkpoints";
import type { TranscriptRow } from "../../../shared/transcript";

/** Match the current prompt, never carry the previous turn's files into a new run. */
export function activeTurnChanges(cells: readonly AgentCell[], checkpoints: readonly CheckpointSummary[]): CheckpointSummary | undefined {
	for (let i = cells.length - 1; i >= 0; i--) {
		const prompt = cells[i];
		if (prompt.type === "user") return checkpoints.find((checkpoint) => checkpoint.cellId === prompt.id && checkpoint.files.length > 0);
	}
	return undefined;
}

/**
 * Keep a completed turn's file summary on its final row, including stopped runs.
 * A turn that is still streaming stays out of this map; the composer shows a
 * live capsule for it instead, and the card joins the transcript once it ends.
 */
export function completedTurnChanges(rows: readonly TranscriptRow[], checkpoints: readonly CheckpointSummary[], streaming: boolean): Map<string, CheckpointSummary> {
	const byPrompt = new Map(checkpoints.filter((checkpoint) => checkpoint.cellId !== null).map((checkpoint) => [checkpoint.cellId, checkpoint]));
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
